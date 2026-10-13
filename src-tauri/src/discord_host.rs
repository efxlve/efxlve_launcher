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
//! visit stays signed in. One exception: a voice call lives in this renderer
//! (no desktop app needed), so while a call is running the page is kept alive
//! as a 1x1 sliver and only closes once the call ends. A 3s probe reads the
//! call (channel, participants) straight from the page's own stores and tells
//! the overlay through `discord-web-voice`, so the in-game card works without
//! the desktop client.
//!
//! Voice chat works through the web client itself: the child answers WebView2's
//! microphone and camera permission requests (a host app must, or WebView2
//! denies them) and Windows records them through its normal privacy gate.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder,
    WebviewUrl,
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
/// True while a child is being built. The frontend asks for the page several
/// times during its entry animation; a second create would bump the generation
/// and orphan the running poller (and the call it guards), so only the first
/// caller builds the child.
static CREATING: AtomicBool = AtomicBool::new(false);
/// True while the web client is in a voice call, straight from the page probe.
static IN_CALL: AtomicBool = AtomicBool::new(false);
/// The user left the page while a call was running: the renderer is kept alive
/// (as a 1x1 sliver, not a hide) until the call ends.
static PARKED: AtomicBool = AtomicBool::new(false);
/// Last web voice report, so a late overlay can pull it while it starts up.
static WEB_VOICE: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// When the last report arrived; a parked page whose reports stop (a broken
/// probe, a Discord update) is closed instead of leaking a renderer.
/// When the page was last navigated. A navigation right on top of another one
/// is how the client's router breaks and the page stays on its loading screen,
/// so the conversation opener keeps a short cooldown between them.
static LAST_NAV: Mutex<Option<Instant>> = Mutex::new(None);

/// The generation an automatic recovery reload already ran for: a page that
/// refuses to paint must not loop reloads forever.
static RECOVERED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// When the current child was created. A page that has had half a minute and
/// never painted is wedged (a navigation can do that), and rebuilding it is
/// the only way back — but a page that is merely still warming up must be
/// left alone.
static CREATED_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// The generation a paint watchdog is already polling.
static WATCHING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

static LAST_REPORT: Mutex<Option<Instant>> = Mutex::new(None);

/// Last logged web-voice note; only transitions reach the log.
static VOICE_NOTE: Mutex<String> = Mutex::new(String::new());

/// Whether the web client is ringing right now: the transition into a ring is
/// what raises the incoming-call notification.
static CALL_RINGING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The call-store report is a one-shot: it only matters while the reader is
/// being built, and it would otherwise flood the log every tick.
static CALL_DIAG_LOGGED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The "keep Discord open" setting, mirrored from the UI. With it on, leaving
/// the page parks it off-screen instead of destroying it — the same trick a
/// live call uses — so messages and calls keep arriving while a game runs.
static KEEP_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Where a kept-alive child parks: far outside the client area, so nothing of
/// it can show even if the platform rounds the size up, while the controller
/// stays visible and the page (and its call) keeps running.
const PARK_RECT: (f64, f64, f64, f64) = (-400.0, -400.0, 1.0, 1.0);

/// A conversation the overlay asked for while the page was gone; the next
/// create loads it instead of the home URL.
static PENDING_URL: Mutex<Option<String>> = Mutex::new(None);

/// The rectangle the frontend last asked for, re-applied when the child comes
/// back from a navigation: a re-shown child otherwise keeps its old frame.
static LAST_RECT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

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

/// Captures the client's webpack require before its runtime can replace or
/// drop the global (`discord_voice_hook.js`, an initialization script).
const VOICE_HOOK_SCRIPT: &str = include_str!("discord_voice_hook.js");

/// Reads the web client's own voice state (`discord_voice_probe.js`, injected
/// through WebView2's native `ExecuteScript`). Every step is defensive and a
/// failed lookup returns `ok: false`, which leaves the overlay on the RPC
/// source.
const VOICE_SCRIPT: &str = include_str!("discord_voice_probe.js");

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

/// Appends one web-side line to the shared Discord log (the file the RPC
/// worker also writes) so page diagnostics land in the same place. Lines carry
/// a UTC stamp: the ordering of create/destroy/park is what matters.
fn web_log(app: &AppHandle, line: &str) {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|age| age.as_secs())
        .unwrap_or(0);
    let stamp = format!(
        "{:02}:{:02}:{:02}Z",
        (seconds / 3600) % 24,
        (seconds / 60) % 60,
        seconds % 60
    );
    eprintln!("[discord-view] {line}");
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join("logs").join("discord-rpc.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "[discord-web] {stamp} {line}");
        }
    }
}

/// Logs a web voice note only when it changes; the probe re-reports the same
/// state every few seconds.
fn note_voice(app: &AppHandle, note: String) {
    let changed = VOICE_NOTE
        .lock()
        .map(|mut guard| {
            if *guard == note {
                false
            } else {
                *guard = note.clone();
                true
            }
        })
        .unwrap_or(false);
    if changed {
        web_log(app, &note);
    }
}

/// A web voice report from the child page: normalizes it, tells the overlay and
/// tracks whether a call is running (that keeps the renderer alive).
fn handle_voice_report(app: &AppHandle, report: serde_json::Value) {
    if report.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let why = report
            .get("why")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        note_voice(app, format!("web voice: unavailable ({why})"));
        return;
    }

    let in_call = report
        .get("inCall")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    // An incoming call rings in the web client: its call store is the only
    // signal, and the ring is what raises the notification.
    let ringing = report
        .get("call")
        .and_then(|call| call.get("ringing"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let caller = report
        .get("call")
        .and_then(|call| call.get("from"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let was_ringing = CALL_RINGING.swap(ringing > 0, Ordering::SeqCst);
    if ringing > 0 && !was_ringing {
        note_voice(app, format!("web call: ringing ({caller})"));
        let _ = app.emit("discord-web-call", serde_json::json!({ "from": caller }));
    } else if ringing == 0 && was_ringing {
        note_voice(app, "web call: stopped ringing".to_string());
    }
    // One line naming the call stores the client exposes, so the reader can be
    // corrected without waiting for someone to ring.
    if !CALL_DIAG_LOGGED.swap(true, Ordering::SeqCst) {
        if let Some(diag) = report.get("callDiag").and_then(serde_json::Value::as_str) {
            if !diag.is_empty() {
                web_log(app, &format!("web call stores: {diag}"));
            }
        }
    }
    let via = report
        .get("via")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    // Relationships come from the same stores, so the launcher's own client can
    // feed the friends card without the desktop app.
    let mut friends = Vec::new();
    if let Some(items) = report
        .get("friends")
        .and_then(serde_json::Value::as_array)
    {
        for item in items.iter().take(300) {
            let id = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let avatar = item
                .get("avatar")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            friends.push(serde_json::json!({
                "id": id,
                "name": item.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
                "avatarUrl": crate::discord_rpc::avatar_url(id, avatar),
                "status": item.get("status").and_then(serde_json::Value::as_str).unwrap_or("offline"),
            }));
        }
    }
    let friends_total = report
        .get("friendsTotal")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(friends.len() as u64);
    let pending = report
        .get("pending")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    // Voice channels the overlay can jump to, grouped by guild in the client's
    // own order (read-only; joining stays in the real client).
    let mut channels = Vec::new();
    if let Some(items) = report
        .get("channels")
        .and_then(serde_json::Value::as_array)
    {
        for item in items.iter().take(24) {
            channels.push(serde_json::json!({
                "id": item.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                "name": item.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
                "guild": item.get("guild").and_then(serde_json::Value::as_str).unwrap_or(""),
                "guildId": item.get("guildId").and_then(serde_json::Value::as_str).unwrap_or(""),
            }));
        }
    }
    let mut channel = serde_json::Value::Null;
    let mut people = Vec::new();
    if in_call {
        if let Some(info) = report.get("channel") {
            channel = serde_json::json!({
                "id": info.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                "name": info.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
                "guild": info.get("guild").and_then(serde_json::Value::as_str).unwrap_or(""),
            });
        }
        if let Some(items) = report
            .get("participants")
            .and_then(serde_json::Value::as_array)
        {
            for item in items.iter().take(25) {
                let id = item
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let avatar = item
                    .get("avatar")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                people.push(serde_json::json!({
                    "id": id,
                    "name": item.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
                    "avatarUrl": crate::discord_rpc::avatar_url(id, avatar),
                    "muted": item.get("muted").and_then(serde_json::Value::as_bool).unwrap_or(false),
                    "speaking": item.get("speaking").and_then(serde_json::Value::as_bool).unwrap_or(false),
                }));
            }
        }
        let name = channel
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        note_voice(
            app,
            format!(
                "web voice: in call \"{name}\" ({} people, {via}, {friends_total} friends){}",
                people.len(),
                match report.get("debug").and_then(serde_json::Value::as_str) {
                    Some(debug) => format!(" [{debug}]"),
                    None => String::new(),
                }
            ),
        );
    } else {
        note_voice(
            app,
            format!("web voice: not in a call ({via}, {friends_total} friends)"),
        );
    }
    IN_CALL.store(in_call, Ordering::SeqCst);
    if let Ok(mut guard) = LAST_REPORT.lock() {
        *guard = Some(Instant::now());
    }

    let payload = serde_json::json!({
        "inCall": in_call,
        "channel": channel,
        "participants": people,
        "friends": friends,
        "friendsTotal": friends_total,
        "pending": pending,
        "channels": channels,
    });
    if let Ok(mut guard) = WEB_VOICE.lock() {
        *guard = Some(payload.clone());
    }
    let _ = app.emit("discord-web-voice", payload);
}

/// Closes the child webview and resets every flag for the next visit.
fn destroy_view(app: &AppHandle) {
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    PAINTED.store(false, Ordering::SeqCst);
    IN_CALL.store(false, Ordering::SeqCst);
    PARKED.store(false, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = CREATED_AT.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = WEB_VOICE.lock() {
        *guard = None;
    }
    let _ = app.emit(
        "discord-web-voice",
        serde_json::json!({
            "inCall": false,
            "channel": serde_json::Value::Null,
            "participants": [],
            "friends": [],
            "friendsTotal": 0,
            "pending": 0
        }),
    );
    if let Some(view) = view(app) {
        eprintln!("[discord-view] destroy");
        web_log(app, "view destroy");
        let _ = view.close();
    }
}

/// Runs the voice read inside the child page through WebView2's own
/// `ExecuteScript` and feeds the returned value to the report handler. This is
/// the same bridge the microphone permission handler uses: the Tauri `eval`
/// wrapper never reached this child, and the native call reports back through
/// its completion handler instead of a navigation.
#[cfg(windows)]
fn poll_voice_script(app: &AppHandle) {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::PCWSTR;

    let Some(view) = view(app) else {
        return;
    };
    let report_app = app.clone();
    let registration = view.with_webview(move |platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(error) => {
                note_voice(
                    &report_app,
                    format!("web voice: script bridge failed ({error})"),
                );
                return;
            }
        };
        let handler_app = report_app.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(
            move |result: windows::core::Result<()>, text: String| {
                if let Err(error) = result {
                    note_voice(
                        &handler_app,
                        format!("web voice: script error ({error})"),
                    );
                    return Ok(());
                }
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|parsed| match parsed {
                        serde_json::Value::String(inner) => {
                            serde_json::from_str::<serde_json::Value>(&inner).ok()
                        }
                        other => Some(other),
                    });
                match value {
                    Some(value) => handle_voice_report(&handler_app, value),
                    None => note_voice(&handler_app, "web voice: unreadable result".to_string()),
                }
                Ok(())
            },
        ));
        let script: Vec<u16> = VOICE_SCRIPT.encode_utf16().chain(std::iter::once(0)).collect();
        if let Err(error) = unsafe { core.ExecuteScript(PCWSTR(script.as_ptr()), &handler) } {
            note_voice(
                &report_app,
                format!("web voice: ExecuteScript failed ({error})"),
            );
        }
    });
    if let Err(error) = registration {
        note_voice(
            app,
            format!("web voice: with_webview failed ({error})"),
        );
    }
}

/// One synchronous voice read, for the moment just before a destructive
/// decision (leaving the page). The periodic poll runs every few seconds, so a
/// call that started in between would otherwise be missed and the renderer
/// closed with the call inside it. Returns `None` when the page cannot answer.
#[cfg(windows)]
fn read_voice_now(app: &AppHandle) -> Option<serde_json::Value> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::PCWSTR;

    let view = view(app)?;
    let (tx, rx) = std::sync::mpsc::channel::<Option<serde_json::Value>>();
    let registration = view.with_webview(move |platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => {
                let _ = tx.send(None);
                return;
            }
        };
        let handler_tx = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(
            move |result: windows::core::Result<()>, text: String| {
                let value = if result.is_ok() {
                    serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|parsed| match parsed {
                            serde_json::Value::String(inner) => {
                                serde_json::from_str::<serde_json::Value>(&inner).ok()
                            }
                            other => Some(other),
                        })
                } else {
                    None
                };
                let _ = handler_tx.send(value);
                Ok(())
            },
        ));
        let script: Vec<u16> = VOICE_SCRIPT.encode_utf16().chain(std::iter::once(0)).collect();
        if unsafe { core.ExecuteScript(PCWSTR(script.as_ptr()), &handler) }.is_err() {
            let _ = tx.send(None);
        }
    });
    if registration.is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_millis(2500)).ok().flatten()
}

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

/// WebView2 denies media permissions unless the host app answers the request,
/// so the embedded Discord client could not unmute. Microphone and camera are
/// allowed for this child; nothing else loads in it (external links open in the
/// system browser) and Windows' own privacy switch still applies.
#[cfg(windows)]
fn allow_media_permissions(view: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs,
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let registration = view.with_webview(|platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(error) => {
                eprintln!("[discord-view] media permission setup failed: {error}");
                return;
            }
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(
            |_sender: Option<ICoreWebView2>,
             args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND(0);
                    if unsafe { args.PermissionKind(&mut kind) }.is_ok()
                        && (kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA)
                    {
                        let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
                    }
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        if let Err(error) = unsafe { core.add_PermissionRequested(&handler, &mut token) } {
            eprintln!("[discord-view] media permission registration failed: {error}");
        }
    });
    if let Err(error) = registration {
        eprintln!("[discord-view] media permission bridge failed: {error}");
    }
}

/// Creates the child webview inside the main window.
async fn create_view(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    let url = match PENDING_URL.lock().ok().and_then(|mut guard| guard.take()) {
        // The overlay asked for a conversation before the page existed.
        Some(pending) => pending
            .parse::<url::Url>()
            .map_err(|_| "bad_url".to_string())?,
        None => HOME_URL
            .parse::<url::Url>()
            .map_err(|_| "bad_url".to_string())?,
    };
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
                        let first = !PAINTED.swap(true, Ordering::SeqCst);
                        if WANT_VISIBLE.load(Ordering::SeqCst) {
                            // Refresh the frame on every report: after a
                            // navigation the child keeps its old (black) frame,
                            // and the page can report once more before it is
                            // torn down, so a transition-only refresh would miss
                            // the new document. Logging stays on the transition.
                            let show_app = nav_app.clone();
                            tauri::async_runtime::spawn(async move {
                                if first {
                                    // Give the first real frame a moment.
                                    tokio::time::sleep(Duration::from_millis(260)).await;
                                }
                                if !WANT_VISIBLE.load(Ordering::SeqCst) {
                                    return;
                                }
                                let Some(view) = view(&show_app) else {
                                    return;
                                };
                                if let Some((x, y, w, h)) =
                                    LAST_RECT.lock().ok().and_then(|guard| *guard)
                                {
                                    let _ = view.set_bounds(rect_of(x, y, w, h));
                                }
                                let _ = view.show();
                                if first {
                                    web_log(&show_app, "page painted; child shown");
                                }
                            });
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
    // Always installed: the client's webpack require is captured before its
    // runtime can replace or drop the global.
    builder = builder.initialization_script(VOICE_HOOK_SCRIPT);
    let position = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0)));

    PAINTED.store(false, Ordering::SeqCst);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    web_log(app, &format!("view create (gen {generation})"));
    if let Ok(mut guard) = CREATED_AT.lock() {
        *guard = Some(Instant::now());
    }

    // `add_child` posts to the main thread and waits; run it off the async
    // runtime so the UI never blocks on creation.
    let target = window.clone();
    let created = tokio::task::spawn_blocking(move || target.add_child(builder, position, size));
    let child = created
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    // Register before the page can ask: WebView2 denies media permissions when
    // the host app has no handler, so the embedded client could not unmute.
    #[cfg(windows)]
    allow_media_permissions(&child);

    // Follows the web client's voice state while this view lives: the page is
    // polled through WebView2's own script bridge and every report lands in
    // `handle_voice_report`. A plain thread, not an async task: the RPC worker
    // shape is proven here, and a task that dies inside the runtime would fail
    // silently. A generation bump (a destroy, a park-close) ends the loop.
    let track_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("discord-voice-tracker".to_string())
        .spawn(move || {
            web_log(&track_app, &format!("tracker started (gen {generation})"));
            let mut ticks: u64 = 0;
            loop {
                std::thread::sleep(Duration::from_secs(3));
                let now = GENERATION.load(Ordering::SeqCst);
                if now != generation {
                    web_log(
                        &track_app,
                        &format!("tracker done (gen {generation} -> {now})"),
                    );
                    return;
                }
                ticks += 1;
                if ticks == 1 {
                    web_log(&track_app, "web voice: first tick");
                }
                poll_voice_script(&track_app);
                // The script's result arrives through its completion handler;
                // give it a moment before the park check reads the flags.
                std::thread::sleep(Duration::from_millis(300));
                let report_age = LAST_REPORT
                    .lock()
                    .ok()
                    .and_then(|guard| *guard)
                    .map(|at| at.elapsed());
                let quiet = report_age
                    .map(|age| age > Duration::from_secs(90))
                    .unwrap_or(false);
                if PARKED.load(Ordering::SeqCst)
                    && !KEEP_OPEN.load(Ordering::SeqCst)
                    && (!IN_CALL.load(Ordering::SeqCst) || quiet)
                {
                    web_log(
                        &track_app,
                        "web voice: the call ended; closing the parked page",
                    );
                    destroy_view(&track_app);
                    return;
                }
            }
        });
    if spawned.is_err() {
        web_log(app, "web voice: tracker could not start");
    }

    // The document can finish loading while the web client is still blank (its
    // assets trickle in on a slow network), so the child stays hidden behind
    // the loading note until `#app-mount` actually has children.
    watch_first_paint(app, generation);

    Ok(())
}

/// Asks the child to report whether the web client has painted, through its own
/// CoreWebView2. Tauri's `eval` wrapper never reached a child webview, which is
/// why the watchdog used to time out and rebuild pages that were already fine.
#[cfg(windows)]
fn run_ready_script(app: &AppHandle) {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::PCWSTR;
    let Some(view) = view(app) else {
        return;
    };
    let _ = view.with_webview(move |platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => return,
        };
        // The script's own probe navigation is the report; the answer is empty.
        let handler = ExecuteScriptCompletedHandler::create(Box::new(
            move |_result: windows::core::Result<()>, _text: String| Ok(()),
        ));
        let script: Vec<u16> = READY_SCRIPT
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let _ = unsafe { core.ExecuteScript(PCWSTR(script.as_ptr()), &handler) };
    });
}

/// Keeps a fresh document hidden behind the loading note until the web client
/// really painted. A destroy bumps the generation, so a stale poll is inert;
/// the timeout shows the child anyway so an error page is never hidden forever.
fn watch_first_paint(app: &AppHandle, generation: u64) {
    // One watchdog per generation: the show path is called on every layout
    // change, and a poller per call would flood the page with readiness probes.
    if WATCHING.swap(generation, Ordering::SeqCst) == generation {
        return;
    }
    let ready_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + FIRST_PAINT_TIMEOUT;
        let mut painted = false;
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(700)).await;
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            if PAINTED.load(Ordering::SeqCst) {
                painted = true;
                break;
            }
            run_ready_script(&ready_app);
        }
        if WATCHING.load(Ordering::SeqCst) == generation {
            WATCHING.store(0, Ordering::SeqCst);
        }
        if painted || GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if GENERATION.load(Ordering::SeqCst) == generation && !PAINTED.load(Ordering::SeqCst) {
            // A navigation can wedge the client: a reload does not revive it,
            // so rebuild the child once per generation and let the fresh page
            // arm its own watchdog.
            if RECOVERED.load(Ordering::SeqCst) != generation {
                RECOVERED.store(generation, Ordering::SeqCst);
                let (x, y, width, height) = LAST_RECT
                    .lock()
                    .ok()
                    .and_then(|guard| *guard)
                    .unwrap_or((0.0, 0.0, 100.0, 100.0));
                web_log(&ready_app, "the client never painted; rebuilding the page");
                let rebuild_app = ready_app.clone();
                tauri::async_runtime::spawn(async move {
                    destroy_view(&rebuild_app);
                    let _ = create_view(&rebuild_app, x, y, width, height).await;
                });
                return;
            }
            if WANT_VISIBLE.load(Ordering::SeqCst) {
                eprintln!("[discord-view] readiness timeout; showing the child anyway");
                if let Some(view) = view(&ready_app) {
                    let _ = view.show();
                }
            }
        }
    });
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
    // The user is back on the page; a parked keep-alive is over.
    PARKED.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = LAST_RECT.lock() {
        *guard = Some((x, y, width, height));
    }
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
        } else {
            // A page that never painted (a navigation can wedge the client) is
            // rebuilt, not reloaded: a reload does not revive it, and the
            // person would stare at the loading note forever. A page that is
            // merely still warming up is left alone.
            let wedged = CREATED_AT
                .lock()
                .ok()
                .and_then(|guard| *guard)
                .map(|at| at.elapsed() > Duration::from_secs(30))
                .unwrap_or(false);
            if wedged {
                web_log(&app, "page is wedged on show; rebuilding the client");
                destroy_view(&app);
                let _ = create_view(&app, x, y, width, height).await;
            }
        }
        return Ok(());
    }
    // Only the first caller builds the child; the others return and let the
    // slot observer settle the final rectangle.
    if CREATING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = create_view(&app, x, y, width, height).await;
    CREATING.store(false, Ordering::SeqCst);
    if result.is_ok() {
        if let Some(view) = view(&app) {
            let _ = view.set_bounds(rect_of(x, y, width, height));
            if PAINTED.load(Ordering::SeqCst) {
                let _ = view.show();
            }
        }
    }
    result
}

/// Hides the page while a covering surface (modal, command palette) is open.
/// The state stays warm for the next show.
#[tauri::command]
pub fn discord_view_hide(app: AppHandle) {
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    if let Some(view) = view(&app) {
        // A call lives in this renderer and a hide can suspend it, so a call
        // keeps the same off-screen sliver the leave path uses.
        if IN_CALL.load(Ordering::SeqCst) {
            let _ = view.set_bounds(rect_of(PARK_RECT.0, PARK_RECT.1, PARK_RECT.2, PARK_RECT.3));
            let _ = view.show();
            return;
        }
        let _ = view.hide();
    }
}

/// Reloads the page (a stuck sign-in or a stale session). The paint gate is
/// lowered first so the loading note comes back: a Discord reload repaints in
/// place and would otherwise look like nothing happened.
#[tauri::command]
pub fn discord_view_reload(app: AppHandle) {
    if let Some(view) = view(&app) {
        PAINTED.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = CREATED_AT.lock() {
            *guard = Some(Instant::now());
        }
        if let Ok(mut guard) = LAST_NAV.lock() {
            *guard = Some(Instant::now());
        }
        let _ = view.hide();
        if let Ok(url) = HOME_URL.parse::<url::Url>() {
            let _ = view.navigate(url);
        }
        watch_first_paint(&app, GENERATION.load(Ordering::SeqCst));
        web_log(&app, "page reload requested");
    }
}

/// Loads the Discord page in the background (parked, hidden) so the client is
/// already connected when the person opens it — and so messages and calls
/// arrive while they play. The launcher calls this at startup when the
/// "keep Discord open" setting is on.
#[tauri::command]
pub async fn discord_view_prewarm(app: AppHandle) -> Result<(), String> {
    KEEP_OPEN.store(true, Ordering::SeqCst);
    if view(&app).is_some() || CREATING.load(Ordering::SeqCst) {
        return Ok(());
    }
    web_log(&app, "prewarming the Discord page");
    let (x, y, width, height) = PARK_RECT;
    if let Ok(mut guard) = LAST_RECT.lock() {
        *guard = Some((x, y, width, height));
    }
    create_view(&app, x, y, width, height).await
}

/// Brings a conversation forward: the overlay asks for a DM or a voice channel
/// and the launcher's own client opens it. Only the client's own channel URLs
/// are accepted; writing stays the person's job in the real client.
#[tauri::command]
pub fn discord_open_conversation(app: AppHandle, url: String) -> Result<(), String> {
    let target = url.parse::<url::Url>().map_err(|_| "bad_url".to_string())?;
    if !is_discord_host(&target) || !target.path().starts_with("/channels/") {
        return Err("not_a_conversation".to_string());
    }
    let clean = target.to_string();
    // Navigating is only safe on a page that is up and healthy: a navigation
    // during a boot (or during a call) is how the blank page and the dropped
    // call happened before. Otherwise the launcher simply comes forward on its
    // Discord page and the person picks the conversation there.
    let healthy = LAST_REPORT
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|at| at.elapsed() < Duration::from_secs(15))
        .unwrap_or(false);
    let too_soon = LAST_NAV
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|at| at.elapsed() < Duration::from_secs(3))
        .unwrap_or(false);
    match view(&app) {
        Some(view) if !too_soon && !IN_CALL.load(Ordering::SeqCst) && healthy => {
            PAINTED.store(false, Ordering::SeqCst);
            // The clock the wedged check reads starts at the navigation, not at
            // the view's creation: otherwise a page older than 30s would be
            // declared wedged on the next show and the deep link thrown away.
            if let Ok(mut guard) = CREATED_AT.lock() {
                *guard = Some(Instant::now());
            }
            if let Ok(mut guard) = LAST_NAV.lock() {
                *guard = Some(Instant::now());
            }
            let _ = view.hide();
            let _ = view.navigate(target);
            watch_first_paint(&app, GENERATION.load(Ordering::SeqCst));
            web_log(&app, "opening a conversation in the launcher client");
        }
        Some(_) => {
            web_log(
                &app,
                if too_soon {
                    "conversation asked again too soon; the client is still moving"
                } else if IN_CALL.load(Ordering::SeqCst) {
                    "conversation asked while in a call; the client stays where it is"
                } else {
                    "page still starting; only bringing the launcher forward"
                },
            );
        }
        None => {
            if let Ok(mut guard) = PENDING_URL.lock() {
                *guard = Some(clean);
            }
            web_log(&app, "conversation queued for the next page load");
        }
    }
    // The main window's frontend switches to its Discord page on this event.
    let _ = app.emit("overlay-focus-discord", ());
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Destroys the child webview when the user leaves the page. A full Discord
/// client renderer is too heavy to keep alive next to the store/Spotify
/// children; the WebView2 profile preserves the session for the next visit.
/// One exception: a running voice call lives in that renderer (no desktop app
/// involved), so it is kept alive off-screen until the call ends, and the state
/// is read once more right before the decision: the periodic poll is a few
/// seconds behind, so a call that started a moment ago would otherwise be
/// missed and closed along with the renderer.
#[tauri::command]
pub async fn discord_view_destroy(app: AppHandle, keep_alive: Option<bool>) {
    if let Some(keep) = keep_alive {
        KEEP_OPEN.store(keep, Ordering::SeqCst);
    }
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    if !IN_CALL.load(Ordering::SeqCst) {
        if let Some(report) = read_voice_now(&app) {
            handle_voice_report(&app, report);
        }
    }
    // A live call and the "keep Discord open" setting keep the renderer alive
    // off-screen; only when neither wants it does the page really close.
    let in_call = IN_CALL.load(Ordering::SeqCst);
    if in_call || KEEP_OPEN.load(Ordering::SeqCst) {
        PARKED.store(true, Ordering::SeqCst);
        web_log(
            &app,
            if in_call {
                "web voice: in a call; the page stays alive while it lasts"
            } else {
                "keep Discord open: the page stays parked"
            },
        );
        if let Some(view) = view(&app) {
            // Off-screen, not a hide: the controller must stay visible or the
            // renderer (and with it the call) can be suspended.
            let _ = view.set_bounds(rect_of(PARK_RECT.0, PARK_RECT.1, PARK_RECT.2, PARK_RECT.3));
            let _ = view.show();
        }
        return;
    }
    destroy_view(&app);
}

/// The last web voice report, so the overlay's card can paint before the next
/// tracker tick.
#[tauri::command]
pub fn discord_web_voice_state() -> Option<serde_json::Value> {
    WEB_VOICE.lock().ok().and_then(|guard| guard.clone())
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
