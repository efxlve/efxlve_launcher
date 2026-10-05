//! Comet process lifecycle for a GOG play session.
//!
//! Comet listens on a fixed local port; the game's Galaxy SDK connects to it,
//! so it must be up before the game starts and may be stopped once the game
//! (and its SDK clients) are gone. Only one instance is ever tracked here.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;

/// Port Comet binds on (its own fixed choice).
const COMET_PORT: u16 = 9977;
/// Seconds Comet waits after the last client disconnects before exiting.
const IDLE_WAIT_SECS: &str = "12";

static COMET_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// True while something already accepts connections on Comet's port: the
/// official Galaxy client, or a Comet started by another launcher.
fn port_busy() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], COMET_PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// True while the Comet instance started by this launcher is alive.
pub fn is_running() -> bool {
    let mut slot = COMET_CHILD.lock().unwrap();
    match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *slot = None;
                false
            }
        },
        None => false,
    }
}

/// Username shown in Comet's notifications. Falls back to a generic label when
/// the saved account has none.
fn active_username(app: &AppHandle) -> String {
    let dir = crate::gogdl::paths::gog_config_dir(app);
    crate::gogdl::accounts::list_saved_gog_accounts(&dir, None)
        .into_iter()
        .find(|a| a.is_active)
        .map(|a| a.username)
        .filter(|name| !name.is_empty() && name != "GOG User")
        .unwrap_or_else(|| "GOG User".to_string())
}

/// Starts Comet for one GOG session. Returns false when the integration is
/// disabled, credentials are missing, it is already running, or the port is
/// taken by another service (then that service serves the game instead).
pub async fn start_for_session(app: &AppHandle) -> bool {
    if !super::enabled(app) || is_running() || port_busy() {
        return false;
    }
    let Some(tokens) = crate::gogdl::cache::load_auth_tokens(app) else {
        return false;
    };
    if tokens.access_token.is_empty() || tokens.user_id.is_empty() {
        return false;
    }
    let Ok(bin) = super::ensure_binary(app).await else {
        return false;
    };

    let mut cmd = Command::new(&bin);
    cmd.args([
        "--access-token",
        &tokens.access_token,
        "--refresh-token",
        &tokens.refresh_token,
        "--user-id",
        &tokens.user_id,
        "--username",
        &active_username(app),
        // Exit on its own shortly after the game disconnects; the session end
        // also kills it, so nothing is left behind either way.
        "--quit",
    ]);
    cmd.env("COMET_IDLE_WAIT", IDLE_WAIT_SECS);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => {
            *COMET_CHILD.lock().unwrap() = Some(child);
            true
        }
        Err(_) => false,
    }
}

/// Stops the tracked instance, if any. Safe to call when nothing runs.
pub fn stop() {
    let mut slot = COMET_CHILD.lock().unwrap();
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
