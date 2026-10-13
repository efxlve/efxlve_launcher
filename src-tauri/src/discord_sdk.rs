//! Discord Social SDK service (Faz 4b): the official **write** path.
//!
//! The C API from `discord_partner_sdk.dll` is bound by hand; every handle the
//! SDK hands out is one opaque pointer, which keeps the bindings exact. A
//! single worker thread owns the client, pumps `Discord_RunCallbacks` (the
//! SDK's callback loop) and drains a command queue, so the client is only ever
//! touched from one thread — the same shape `presence.rs` uses.
//!
//! First run follows the documented quick start: Authorize (PKCE) → GetToken →
//! UpdateToken → Connect. The session that comes back is sealed with DPAPI next
//! to the RPC token, so later runs refresh silently and never ask again.
//! `Discord_Client_SendUserMessage` is the write path the overlay composer uses.
//!
//! The state (status, the account, the relationship list) is mirrored to the
//! UI through `discord-sdk-state` and `discord-sdk-friends` events, and every
//! send reports through `discord-sdk-dm`. Everything lands in the shared
//! Discord log (`[discord-sdk]` lines) so a failed step reads like the rest of
//! the integration. Without the vendored SDK (see `build.rs`) the commands stay
//! a no-op, so the build never depends on the 745 MB download.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// The launcher's Discord application; the same id the rest of the feature uses.
#[cfg(discord_sdk)]
const CLIENT_ID: u64 = 1551663205426794596;
/// Registered in the portal for desktop apps (OAuth2 → Redirects).
#[cfg(discord_sdk)]
const REDIRECT_HINT: &str = "http://127.0.0.1/callback";

/// One worker per app run.
static STARTED: AtomicBool = AtomicBool::new(false);
/// The command queue into the worker (the client lives on that thread).
static COMMANDS: Mutex<Option<Sender<SdkCommand>>> = Mutex::new(None);
/// The app handle for logging and events; set before the worker starts.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// What the UI shows: status, the signed-in account and the relationship list.
static STATE: Mutex<SdkState> = Mutex::new(SdkState::new());

#[cfg(discord_sdk)]
static CLIENT_PTR: std::sync::atomic::AtomicPtr<ffi::Client> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

enum SdkCommand {
    SendDm { user_id: u64, text: String },
    EditDm { user_id: u64, message_id: u64, text: String },
    DeleteDm { user_id: u64, message_id: u64 },
    FriendRequest { user_id: u64, accept: bool },
    History { user_id: u64, limit: i32 },
    Search { query: String },
    AddFriend { username: String },
    Channels,
    SetStatus { code: i32, label: String },
    Call { user_id: u64 },
    Hangup,
    CallMute { mute: bool },
}

/// The signed-in account, as the composer header shows it.
#[derive(Clone)]
struct SdkMe {
    id: String,
    name: String,
    avatar_url: String,
    /// "online" | "idle" | "dnd" | "offline" (invisible reads as offline).
    status: String,
}

/// One relationship row, shaped like the page/RPC friend entries so the
/// overlay renders all three sources the same way.
#[derive(Clone)]
struct SdkFriend {
    id: String,
    name: String,
    avatar_url: String,
    /// "online" | "idle" | "dnd" | "offline"
    status: String,
}

#[derive(Clone)]
struct SdkState {
    /// "" | "starting" | "authorizing" | "connecting" | "ready" | "error"
    status: String,
    error: Option<String>,
    me: Option<SdkMe>,
    friends: Vec<SdkFriend>,
    /// Incoming friend requests, ready to accept or reject.
    pending_users: Vec<SdkFriend>,
    pending: u32,
}

impl SdkState {
    const fn new() -> Self {
        Self {
            status: String::new(),
            error: None,
            me: None,
            friends: Vec::new(),
            pending_users: Vec::new(),
            pending: 0,
        }
    }
}

fn with_state<T>(f: impl FnOnce(&mut SdkState) -> T) -> Option<T> {
    let mut guard = STATE.lock().ok()?;
    Some(f(&mut guard))
}

fn state_json(state: &SdkState) -> serde_json::Value {
    serde_json::json!({
        "status": if state.status.is_empty() { "idle" } else { state.status.as_str() },
        "error": state.error,
        "me": state.me.as_ref().map(|me| serde_json::json!({
            "id": me.id,
            "name": me.name,
            "avatarUrl": me.avatar_url,
            "status": me.status,
        })),
    })
}

fn friends_json(state: &SdkState) -> serde_json::Value {
    let status = if state.status == "ready" {
        "ready"
    } else if state.status == "error" {
        "error"
    } else {
        "connecting"
    };
    serde_json::json!({
        "status": status,
        "friends": state.friends.iter().map(|friend| serde_json::json!({
            "id": friend.id,
            "name": friend.name,
            "avatarUrl": friend.avatar_url,
            "status": friend.status,
        })).collect::<Vec<_>>(),
        "pendingUsers": state.pending_users.iter().map(|friend| serde_json::json!({
            "id": friend.id,
            "name": friend.name,
            "avatarUrl": friend.avatar_url,
            "status": friend.status,
        })).collect::<Vec<_>>(),
        "pending": state.pending,
        "error": state.error,
    })
}

/// Appends one line to the shared Discord log (the file the RPC worker and the
/// page host also write). Every SDK callback logs through here, so the whole
/// flow reads from one place.
fn sdk_log(line: &str) {
    use std::io::Write;
    eprintln!("[discord-sdk] {line}");
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    if let Ok(dir) = {
        use tauri::Manager;
        app.path().app_data_dir()
    } {
        let path = dir.join("logs").join("discord-rpc.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "[discord-sdk] {line}");
        }
    }
}

fn set_state(status: &str, error: Option<String>) {
    let status = status.to_string();
    with_state(|state| {
        state.status = status;
        state.error = error;
    });
    emit_state();
}

fn emit_state() {
    let Some(payload) = with_state(|state| state_json(state)) else {
        return;
    };
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("discord-sdk-state", payload);
    }
}

fn emit_friends() {
    let Some(payload) = with_state(|state| friends_json(state)) else {
        return;
    };
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("discord-sdk-friends", payload);
    }
}

/// Starts the client: resumes the sealed session, or asks for authorization on
/// the first run. Idempotent; the worker lives until the app exits.
///
/// `silent` is the automatic start (the overlay booting): it resumes a stored
/// session but never opens the approval prompt on its own — a first-time user
/// gets the Connect button instead. The button passes `false`.
#[tauri::command]
pub fn discord_sdk_start(app: AppHandle, silent: bool) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    set_state("starting", None);
    let (tx, rx) = channel::<SdkCommand>();
    if let Ok(mut guard) = COMMANDS.lock() {
        *guard = Some(tx);
    }
    let spawned = std::thread::Builder::new()
        .name("discord-sdk".to_string())
        .spawn(move || worker(app, rx, silent));
    if spawned.is_err() {
        sdk_log("worker could not start");
        set_state("error", Some("worker_gone".to_string()));
        return Err("worker_gone".to_string());
    }
    Ok(())
}

/// The current state, so a freshly opened panel paints without waiting.
#[tauri::command]
pub fn discord_sdk_state() -> serde_json::Value {
    with_state(|state| state_json(state)).unwrap_or_else(|| serde_json::json!({ "status": "idle" }))
}

/// The relationship list the SDK read, in the overlay's friend shape.
#[tauri::command]
pub fn discord_sdk_friends() -> serde_json::Value {
    with_state(|state| friends_json(state))
        .unwrap_or_else(|| serde_json::json!({ "status": "connecting", "friends": [], "pending": 0 }))
}

/// Sends a direct message through the SDK (the composer's path). The `user_id`
/// is a Discord snowflake; the worker owns the actual call and reports the
/// outcome through `discord-sdk-dm`.
#[tauri::command]
pub fn discord_sdk_send_dm(user_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty_message".to_string());
    }
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::SendDm {
            user_id: id,
            text,
        })
        .map_err(|_| "worker_gone".to_string())
}

/// Deletes one of the messages the overlay sent; the outcome arrives on
/// `discord-sdk-dm-deleted`.
#[tauri::command]
pub fn discord_sdk_delete_dm(user_id: String, message_id: String) -> Result<(), String> {
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let message = message_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_message_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::DeleteDm {
            user_id: id,
            message_id: message,
        })
        .map_err(|_| "worker_gone".to_string())
}

/// Rewrites one of the messages the overlay sent; the outcome arrives on
/// `discord-sdk-dm-edited`.
#[tauri::command]
pub fn discord_sdk_edit_dm(user_id: String, message_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty_message".to_string());
    }
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let message = message_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_message_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::EditDm {
            user_id: id,
            message_id: message,
            text,
        })
        .map_err(|_| "worker_gone".to_string())
}

/// Accepts or rejects an incoming friend request; the outcome arrives on
/// `discord-sdk-request-done`.
#[tauri::command]
pub fn discord_sdk_friend_request(user_id: String, accept: bool) -> Result<(), String> {
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::FriendRequest {
            user_id: id,
            accept,
        })
        .map_err(|_| "worker_gone".to_string())
}

/// The last messages of one conversation; the result arrives on
/// `discord-sdk-history`.
#[tauri::command]
pub fn discord_sdk_history(user_id: String, limit: Option<i32>) -> Result<(), String> {
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::History {
            user_id: id,
            limit: limit.unwrap_or(30).clamp(1, 100),
        })
        .map_err(|_| "worker_gone".to_string())
}

/// Looks up users by username; the results arrive on `discord-sdk-search`.
#[tauri::command]
pub fn discord_sdk_search_users(query: String) -> Result<(), String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("empty_query".to_string());
    }
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::Search { query })
        .map_err(|_| "worker_gone".to_string())
}

/// Sends a friend request by username; the outcome arrives on
/// `discord-sdk-request-sent`.
#[tauri::command]
pub fn discord_sdk_add_friend(username: String) -> Result<(), String> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("empty_query".to_string());
    }
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::AddFriend { username })
        .map_err(|_| "worker_gone".to_string())
}

/// Refreshes the voice-channel list; the result arrives on
/// `discord-sdk-channels`.
#[tauri::command]
pub fn discord_sdk_channels() -> Result<(), String> {
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::Channels)
        .map_err(|_| "worker_gone".to_string())
}

/// Sets the account's own online status (online / idle / dnd / invisible /
/// offline); the outcome arrives on `discord-sdk-status-done`.
#[tauri::command]
pub fn discord_sdk_set_status(status: String) -> Result<(), String> {
    let code = match status.as_str() {
        "online" => 0,
        "offline" => 1,
        "idle" => 3,
        "dnd" => 4,
        "invisible" => 5,
        _ => return Err("bad_status".to_string()),
    };
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::SetStatus { code, label: status })
        .map_err(|_| "worker_gone".to_string())
}

/// Starts a voice call in the direct-message channel with a friend; the state
/// arrives on `discord-sdk-call`.
#[tauri::command]
pub fn discord_sdk_call(user_id: String) -> Result<(), String> {
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
    if !ready {
        return Err("not_ready".to_string());
    }
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::Call { user_id: id })
        .map_err(|_| "worker_gone".to_string())
}

/// Ends the call the overlay started.
#[tauri::command]
pub fn discord_sdk_hangup() -> Result<(), String> {
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::Hangup)
        .map_err(|_| "worker_gone".to_string())
}

/// Mutes (or unmutes) the microphone of the call the overlay started.
#[tauri::command]
pub fn discord_sdk_call_mute(mute: bool) -> Result<(), String> {
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("worker_gone".to_string());
    };
    sender
        .send(SdkCommand::CallMute { mute })
        .map_err(|_| "worker_gone".to_string())
}

/* ---------- Sealed session (compiled only with the vendored SDK) ---------- */

/// The OAuth session kept between launches: the refresh token is the part that
/// matters, the access token saves one round trip on start.
#[cfg(discord_sdk)]
#[derive(serde::Serialize, serde::Deserialize)]
struct SdkSession {
    access_token: String,
    refresh_token: String,
    /// Unix seconds; refreshed early so an expired token never leaves the app.
    expires_at: u64,
}

#[cfg(discord_sdk)]
fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(discord_sdk)]
fn session_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("discord").join("sdk-session.bin"))
}

#[cfg(discord_sdk)]
fn load_session(app: &AppHandle) -> Option<SdkSession> {
    let path = session_path(app)?;
    let sealed = std::fs::read(path).ok()?;
    let plain = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

#[cfg(discord_sdk)]
fn save_session(session: &SdkSession) {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let Some(path) = session_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(plain) = serde_json::to_vec(session) {
        if let Ok(sealed) = crate::steam_auth::vault::dpapi::protect(&plain) {
            let _ = std::fs::write(path, sealed);
        }
    }
}

/* ---------- SDK implementation (compiled only with the vendored SDK) ---------- */

#[cfg(discord_sdk)]
#[allow(dead_code)]
mod ffi {
    //! Hand-written bindings for the Social SDK C API (`cdiscord.h`, 1.10).

    use std::ffi::c_void;

    /// `Discord_String { uint8_t* ptr; size_t size; }`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct StringValue {
        pub ptr: *mut u8,
        pub size: usize,
    }

    macro_rules! opaque {
        ($name:ident) => {
            /// An opaque SDK handle: the C API exposes one pointer per type.
            #[repr(C)]
            #[derive(Clone, Copy)]
            pub struct $name {
                pub opaque: *mut c_void,
            }
        };
    }
    opaque!(Client);
    opaque!(ClientResult);
    opaque!(AuthorizationArgs);
    opaque!(CodeVerifier);
    opaque!(CodeChallenge);
    opaque!(UserHandle);
    opaque!(RelationshipHandle);
    opaque!(MessageHandle);
    opaque!(UserMessageSummary);
    opaque!(GuildMinimal);
    opaque!(GuildChannel);
    opaque!(Call);

    #[repr(C)]
    pub struct RelationshipSpan {
        pub ptr: *mut RelationshipHandle,
        pub size: usize,
    }

    /// `Discord_UserMessageSummarySpan { Discord_UserMessageSummary* ptr; size_t size; }`.
    #[repr(C)]
    pub struct UserMessageSummarySpan {
        pub ptr: *mut UserMessageSummary,
        pub size: usize,
    }

    /// `Discord_MessageHandleSpan { Discord_MessageHandle* ptr; size_t size; }`.
    #[repr(C)]
    pub struct MessageHandleSpan {
        pub ptr: *mut MessageHandle,
        pub size: usize,
    }

    /// `Discord_UserHandleSpan { Discord_UserHandle* ptr; size_t size; }`.
    #[repr(C)]
    pub struct UserHandleSpan {
        pub ptr: *mut UserHandle,
        pub size: usize,
    }

    /// `Discord_GuildMinimalSpan { Discord_GuildMinimal* ptr; size_t size; }`.
    #[repr(C)]
    pub struct GuildMinimalSpan {
        pub ptr: *mut GuildMinimal,
        pub size: usize,
    }

    /// `Discord_GuildChannelSpan { Discord_GuildChannel* ptr; size_t size; }`.
    #[repr(C)]
    pub struct GuildChannelSpan {
        pub ptr: *mut GuildChannel,
        pub size: usize,
    }

    pub type FreeFn = unsafe extern "C" fn(*mut c_void);
    pub type LogCallback = unsafe extern "C" fn(StringValue, i32, *mut c_void);
    pub type StatusCallback = unsafe extern "C" fn(i32, i32, i32, *mut c_void);
    pub type AuthorizeCallback =
        unsafe extern "C" fn(*mut ClientResult, StringValue, StringValue, *mut c_void);
    pub type TokenCallback = unsafe extern "C" fn(
        *mut ClientResult,
        StringValue,
        StringValue,
        i32,
        i32,
        StringValue,
        *mut c_void,
    );
    pub type UpdateTokenCallback = unsafe extern "C" fn(*mut ClientResult, *mut c_void);
    pub type SendMessageCallback = unsafe extern "C" fn(*mut ClientResult, u64, *mut c_void);
    pub type MessageCreatedCallback = unsafe extern "C" fn(u64, *mut c_void);
    pub type MessageDeletedCallback = unsafe extern "C" fn(u64, u64, *mut c_void);
    pub type TokenExpirationCallback = unsafe extern "C" fn(*mut c_void);
    /// `void(uint64_t userId, bool isDiscordRelationshipUpdate, void*)`.
    pub type RelationshipCallback = unsafe extern "C" fn(u64, bool, *mut c_void);
    /// `void(Discord_ClientResult*, void*)`: edit, delete and friends share it.
    pub type ResultCallback = unsafe extern "C" fn(*mut ClientResult, *mut c_void);
    /// `void(void* userData)`: a call that ended.
    pub type EndCallCallback = unsafe extern "C" fn(*mut c_void);
    pub type UserMessageSummariesCallback =
        unsafe extern "C" fn(*mut ClientResult, UserMessageSummarySpan, *mut c_void);
    pub type UserMessagesWithLimitCallback =
        unsafe extern "C" fn(*mut ClientResult, MessageHandleSpan, *mut c_void);
    pub type UserGuildsCallback =
        unsafe extern "C" fn(*mut ClientResult, GuildMinimalSpan, *mut c_void);
    pub type GuildChannelsCallback =
        unsafe extern "C" fn(*mut ClientResult, GuildChannelSpan, *mut c_void);

    #[link(name = "discord_partner_sdk")]
    extern "C" {
        pub fn Discord_RunCallbacks();
        pub fn Discord_Client_Init(client: *mut Client);
        pub fn Discord_Client_GetDefaultCommunicationScopes(out: *mut StringValue);
        pub fn Discord_Client_AddLogCallback(
            client: *mut Client,
            callback: LogCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
            min_severity: i32,
        );
        pub fn Discord_Client_SetStatusChangedCallback(
            client: *mut Client,
            callback: StatusCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetMessageCreatedCallback(
            client: *mut Client,
            callback: MessageCreatedCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetMessageDeletedCallback(
            client: *mut Client,
            callback: MessageDeletedCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetTokenExpirationCallback(
            client: *mut Client,
            callback: TokenExpirationCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetRelationshipCreatedCallback(
            client: *mut Client,
            callback: RelationshipCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetRelationshipDeletedCallback(
            client: *mut Client,
            callback: RelationshipCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_AcceptDiscordFriendRequest(
            client: *mut Client,
            user_id: u64,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_RejectDiscordFriendRequest(
            client: *mut Client,
            user_id: u64,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SearchFriendsByUsername(
            client: *mut Client,
            search: StringValue,
            out: *mut UserHandleSpan,
        );
        pub fn Discord_Client_SendDiscordFriendRequest(
            client: *mut Client,
            username: StringValue,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_GetUserGuilds(
            client: *mut Client,
            callback: UserGuildsCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_GetGuildChannels(
            client: *mut Client,
            guild_id: u64,
            callback: GuildChannelsCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_SetOnlineStatus(
            client: *mut Client,
            status: i32,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_StartCall(
            client: *mut Client,
            channel_id: u64,
            out: *mut Call,
        ) -> bool;
        pub fn Discord_Client_EndCall(
            client: *mut Client,
            channel_id: u64,
            callback: EndCallCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Call_SetSelfMute(call: *mut Call, mute: bool);
        pub fn Discord_Call_SetSelfDeaf(call: *mut Call, deaf: bool);
        pub fn Discord_Call_GetChannelId(call: *mut Call) -> u64;
        pub fn Discord_Call_Drop(call: *mut Call);
        pub fn Discord_MessageHandle_ChannelId(handle: *mut MessageHandle) -> u64;
        pub fn Discord_GuildMinimal_Id(guild: *mut GuildMinimal) -> u64;
        pub fn Discord_GuildMinimal_Name(guild: *mut GuildMinimal, out: *mut StringValue);
        pub fn Discord_GuildMinimal_Drop(guild: *mut GuildMinimal);
        pub fn Discord_GuildChannel_Id(channel: *mut GuildChannel) -> u64;
        pub fn Discord_GuildChannel_Name(channel: *mut GuildChannel, out: *mut StringValue);
        pub fn Discord_GuildChannel_Type(channel: *mut GuildChannel) -> i32;
        pub fn Discord_GuildChannel_Drop(channel: *mut GuildChannel);
        pub fn Discord_Client_DeleteUserMessage(
            client: *mut Client,
            recipient_id: u64,
            message_id: u64,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_EditUserMessage(
            client: *mut Client,
            recipient_id: u64,
            message_id: u64,
            content: StringValue,
            callback: ResultCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_GetMessageHandle(
            client: *mut Client,
            message_id: u64,
            out: *mut MessageHandle,
        ) -> bool;
        pub fn Discord_Client_GetUserMessagesWithLimit(
            client: *mut Client,
            recipient_id: u64,
            limit: i32,
            callback: UserMessagesWithLimitCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_MessageHandle_Id(handle: *mut MessageHandle) -> u64;
        pub fn Discord_MessageHandle_Content(handle: *mut MessageHandle, out: *mut StringValue);
        pub fn Discord_MessageHandle_AdditionalName(
            handle: *mut MessageHandle,
            out: *mut StringValue,
        ) -> bool;
        pub fn Discord_MessageHandle_AuthorId(handle: *mut MessageHandle) -> u64;
        pub fn Discord_MessageHandle_RecipientId(handle: *mut MessageHandle) -> u64;
        pub fn Discord_MessageHandle_SentTimestamp(handle: *mut MessageHandle) -> u64;
        pub fn Discord_MessageHandle_Drop(handle: *mut MessageHandle);
        pub fn Discord_Client_GetUserMessageSummaries(
            client: *mut Client,
            callback: UserMessageSummariesCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_UserMessageSummary_UserId(summary: *mut UserMessageSummary) -> u64;
        pub fn Discord_UserMessageSummary_LastMessageId(summary: *mut UserMessageSummary) -> u64;
        pub fn Discord_UserMessageSummary_Drop(summary: *mut UserMessageSummary);
        pub fn Discord_Client_CreateAuthorizationCodeVerifier(
            client: *mut Client,
            out: *mut CodeVerifier,
        );
        pub fn Discord_AuthorizationCodeVerifier_Challenge(
            verifier: *mut CodeVerifier,
            out: *mut CodeChallenge,
        );
        pub fn Discord_AuthorizationCodeVerifier_Verifier(
            verifier: *mut CodeVerifier,
            out: *mut StringValue,
        );
        pub fn Discord_AuthorizationArgs_Init(args: *mut AuthorizationArgs);
        pub fn Discord_AuthorizationArgs_SetClientId(args: *mut AuthorizationArgs, value: u64);
        pub fn Discord_AuthorizationArgs_SetScopes(args: *mut AuthorizationArgs, value: StringValue);
        pub fn Discord_AuthorizationArgs_SetCodeChallenge(
            args: *mut AuthorizationArgs,
            value: *mut CodeChallenge,
        );
        pub fn Discord_Client_Authorize(
            client: *mut Client,
            args: *mut AuthorizationArgs,
            callback: AuthorizeCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_GetToken(
            client: *mut Client,
            application_id: u64,
            code: StringValue,
            code_verifier: StringValue,
            redirect_uri: StringValue,
            callback: TokenCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_RefreshToken(
            client: *mut Client,
            application_id: u64,
            refresh_token: StringValue,
            callback: TokenCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_UpdateToken(
            client: *mut Client,
            token_type: i32,
            token: StringValue,
            callback: UpdateTokenCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_Connect(client: *mut Client);
        pub fn Discord_Client_GetCurrentUserV2(client: *mut Client, out: *mut UserHandle) -> bool;
        pub fn Discord_Client_GetRelationships(client: *mut Client, out: *mut RelationshipSpan);
        pub fn Discord_Client_GetUser(
            client: *mut Client,
            user_id: u64,
            out: *mut UserHandle,
        ) -> bool;
        pub fn Discord_RelationshipHandle_DiscordRelationshipType(
            handle: *mut RelationshipHandle,
        ) -> i32;
        pub fn Discord_RelationshipHandle_Id(handle: *mut RelationshipHandle) -> u64;
        pub fn Discord_UserHandle_Id(handle: *mut UserHandle) -> u64;
        pub fn Discord_UserHandle_DisplayName(handle: *mut UserHandle, out: *mut StringValue);
        pub fn Discord_UserHandle_Username(handle: *mut UserHandle, out: *mut StringValue);
        pub fn Discord_UserHandle_Avatar(handle: *mut UserHandle, out: *mut StringValue) -> bool;
        pub fn Discord_UserHandle_Status(handle: *mut UserHandle) -> i32;
        pub fn Discord_UserHandle_Drop(handle: *mut UserHandle);
        pub fn Discord_Client_SendUserMessage(
            client: *mut Client,
            recipient_id: u64,
            content: StringValue,
            callback: SendMessageCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_ClientResult_Successful(result: *mut ClientResult) -> bool;
        pub fn Discord_ClientResult_Error(result: *mut ClientResult, out: *mut StringValue) -> bool;
        pub fn Discord_ClientResult_ErrorCode(result: *mut ClientResult) -> i32;
    }
}

#[cfg(discord_sdk)]
mod imp {
    use super::*;
    use ffi::*;
    use std::ffi::c_void;
    use std::ptr;

    /// The callbacks log through the shared Discord log (the prefix comes from
    /// `sdk_log`), so the whole flow reads from one file.
    macro_rules! sdk_note {
        ($($arg:tt)*) => {
            super::sdk_log(&format!($($arg)*))
        };
    }

    /// What the authorize chain needs while the SDK calls us back: the client
    /// pointer (the worker owns it) and the PKCE verifier for the token step.
    struct Flow {
        client: *mut Client,
        verifier: String,
    }

    /// The recipient of an in-flight send (or the target of a delete), handed
    /// to the completion callback.
    struct SendCtx {
        user_id: u64,
        message_id: u64,
    }

    /// An edit in flight: the callback reports the new text back to the panel.
    struct EditCtx {
        user_id: u64,
        message_id: u64,
        text: String,
    }

    /// A friend request being accepted or rejected.
    struct RequestCtx {
        user_id: u64,
        accept: bool,
    }

    /// A friend request being sent by username.
    struct AddFriendCtx {
        username: String,
    }

    /// A status change in flight: the callback reports which one landed.
    struct StatusCtx {
        label: String,
    }

    unsafe extern "C" fn free_flow(user: *mut c_void) {
        drop(Box::from_raw(user as *mut Flow));
    }

    unsafe extern "C" fn free_send(user: *mut c_void) {
        drop(Box::from_raw(user as *mut SendCtx));
    }

    unsafe extern "C" fn free_edit(user: *mut c_void) {
        drop(Box::from_raw(user as *mut EditCtx));
    }

    unsafe extern "C" fn free_request(user: *mut c_void) {
        drop(Box::from_raw(user as *mut RequestCtx));
    }

    unsafe extern "C" fn free_add_friend(user: *mut c_void) {
        drop(Box::from_raw(user as *mut AddFriendCtx));
    }

    unsafe extern "C" fn free_status(user: *mut c_void) {
        drop(Box::from_raw(user as *mut StatusCtx));
    }

    /// Last automatic reconnect attempt, so a dead session does not spin.
    static LAST_RECONNECT: Mutex<Option<Instant>> = Mutex::new(None);

    /// The gateway dropped us (a rejected token is the usual cause): refresh
    /// from the sealed session and come back, at most once every half minute,
    /// so an expired session heals itself instead of showing the sign-in card.
    unsafe fn reconnect_after_drop() {
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() {
            return;
        }
        let now = Instant::now();
        let too_soon = LAST_RECONNECT
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .map(|at| now.duration_since(at) < Duration::from_secs(30))
            .unwrap_or(false);
        if too_soon {
            return;
        }
        if let Ok(mut guard) = LAST_RECONNECT.lock() {
            *guard = Some(now);
        }
        let Some(session) = APP_HANDLE.get().and_then(load_session) else {
            sdk_note!("connection dropped and no stored session to recover with");
            set_state("idle", None);
            return;
        };
        sdk_note!("connection dropped; refreshing the stored session");
        set_state("connecting", None);
        let flow = Box::into_raw(Box::new(Flow {
            client,
            verifier: String::new(),
        }));
        Discord_Client_RefreshToken(
            client,
            CLIENT_ID,
            borrow_str(&session.refresh_token),
            on_token,
            None,
            flow as *mut Flow as *mut c_void,
        );
    }

    /// Tells the UI where the call stands.
    fn emit_call(state: &str, friend_id: u64, muted: bool, error: Option<String>) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "discord-sdk-call",
                serde_json::json!({
                    "state": state,
                    "friendId": friend_id.to_string(),
                    "muted": muted,
                    "error": error,
                }),
            );
        }
    }

    unsafe extern "C" fn on_call_ended(_user: *mut c_void) {
        sdk_note!("call ended");
        emit_call("idle", 0, false, None);
    }

    /// The outcome of an online-status change; the social graph is re-read so
    /// the chip in the panel matches what Discord now shows.
    unsafe extern "C" fn on_status_result(result: *mut ClientResult, user: *mut c_void) {
        let ctx = &*(user as *mut StatusCtx);
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!("online status set to {}", ctx.label);
            serde_json::json!({ "status": ctx.label, "ok": true })
        } else {
            let error = result_error(result);
            sdk_note!("status change failed: {error}");
            serde_json::json!({ "status": ctx.label, "ok": false, "error": error })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-status-done", payload);
        }
        read_social();
    }

    /// The voice channels found so far, across the per-guild fetches.
    static VOICE_CHANNELS: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

    /// A guild whose channels are being fetched: the callback carries its id
    /// (the launcher's channel URL needs it) and its name (the row shows it).
    struct GuildCtx {
        id: u64,
        name: String,
    }

    unsafe extern "C" fn free_guild(user: *mut c_void) {
        drop(Box::from_raw(user as *mut GuildCtx));
    }

    /// Step one: the guild list. Each guild then asks for its own channels, so
    /// the answers arrive in pieces and the panel grows as they do.
    unsafe extern "C" fn on_guilds(
        result: *mut ClientResult,
        guilds: GuildMinimalSpan,
        _user: *mut c_void,
    ) {
        if !Discord_ClientResult_Successful(result) {
            sdk_note!("guild list failed: {}", result_error(result));
            return;
        }
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() || guilds.ptr.is_null() {
            return;
        }
        if let Ok(mut list) = VOICE_CHANNELS.lock() {
            list.clear();
        }
        // A cap keeps the fan-out sane: the panel wants the voice channels a
        // person can jump to, not a directory of every server.
        let count = guilds.size.min(12);
        for index in 0..count {
            let mut guild = *guilds.ptr.add(index);
            let id = Discord_GuildMinimal_Id(&mut guild);
            let mut name = StringValue {
                ptr: ptr::null_mut(),
                size: 0,
            };
            Discord_GuildMinimal_Name(&mut guild, &mut name);
            Discord_GuildMinimal_Drop(&mut guild);
            let ctx = Box::into_raw(Box::new(GuildCtx {
                id,
                name: string_of(name),
            }));
            Discord_Client_GetGuildChannels(
                client,
                id,
                on_channels,
                Some(free_guild),
                ctx as *mut GuildCtx as *mut c_void,
            );
        }
        sdk_note!("guild list: {} guilds (asking {count} for channels)", guilds.size);
    }

    /// Step two: one guild's channels; the voice ones are kept and pushed out.
    unsafe extern "C" fn on_channels(
        result: *mut ClientResult,
        channels: GuildChannelSpan,
        user: *mut c_void,
    ) {
        let ctx = &*(user as *mut GuildCtx);
        if !Discord_ClientResult_Successful(result) || channels.ptr.is_null() {
            return;
        }
        let mut payload: Option<Vec<serde_json::Value>> = None;
        if let Ok(mut list) = VOICE_CHANNELS.lock() {
            let mut added = 0;
            for index in 0..channels.size {
                let mut channel = *channels.ptr.add(index);
                // 2 = Discord_ChannelType_GuildVoice.
                let kind = Discord_GuildChannel_Type(&mut channel);
                let id = Discord_GuildChannel_Id(&mut channel);
                let mut name = StringValue {
                    ptr: ptr::null_mut(),
                    size: 0,
                };
                if kind == 2 {
                    Discord_GuildChannel_Name(&mut channel, &mut name);
                }
                Discord_GuildChannel_Drop(&mut channel);
                if kind != 2 {
                    continue;
                }
                let id_text = id.to_string();
                if list
                    .iter()
                    .any(|item| item.get("id").and_then(|value| value.as_str()) == Some(id_text.as_str()))
                {
                    continue;
                }
                list.push(serde_json::json!({
                    "id": id_text,
                    "name": string_of(name),
                    "guild": ctx.name,
                    "guildId": ctx.id.to_string(),
                }));
                added += 1;
            }
            if added > 0 {
                payload = Some(list.clone());
            }
        }
        if let Some(channels) = payload {
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit(
                    "discord-sdk-channels",
                    serde_json::json!({ "channels": channels }),
                );
            }
        }
    }

    /// The outcome of a friend request sent by username.
    unsafe extern "C" fn on_friend_request_sent(result: *mut ClientResult, user: *mut c_void) {
        let ctx = &*(user as *mut AddFriendCtx);
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!("friend request sent to {}", ctx.username);
            serde_json::json!({ "username": ctx.username, "ok": true })
        } else {
            let error = result_error(result);
            sdk_note!("friend request failed: {error}");
            serde_json::json!({ "username": ctx.username, "ok": false, "error": error })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-request-sent", payload);
        }
    }

    fn string_of(value: StringValue) -> String {
        if value.ptr.is_null() || value.size == 0 {
            return String::new();
        }
        let slice = unsafe { std::slice::from_raw_parts(value.ptr, value.size) };
        String::from_utf8_lossy(slice).to_string()
    }

    fn borrow_str(value: &str) -> StringValue {
        StringValue {
            ptr: value.as_ptr() as *mut u8,
            size: value.len(),
        }
    }

    fn result_error(result: *mut ClientResult) -> String {
        let mut message = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        let code = unsafe { Discord_ClientResult_ErrorCode(result) };
        let _ = unsafe { Discord_ClientResult_Error(result, &mut message) };
        format!("{code}: {}", string_of(message))
    }

    unsafe extern "C" fn on_log(message: StringValue, severity: i32, _user: *mut c_void) {
        let text = string_of(message);
        if !text.is_empty() {
            sdk_note!("[sdk:{severity}] {text}");
        }
    }

    /// Ready is the moment the account and the relationship list are worth
    /// reading; every other status only moves the state machine.
    unsafe extern "C" fn on_status(status: i32, error: i32, detail: i32, _user: *mut c_void) {
        sdk_note!("status {status} (error {error}/{detail})");
        match status {
            3 => {
                set_state("ready", None);
                read_social();
                // The voice channels the panel can jump to. The answers arrive
                // in pieces and update the list as they land.
                let client = super::CLIENT_PTR.load(Ordering::SeqCst);
                if !client.is_null() {
                    Discord_Client_GetUserGuilds(client, on_guilds, None, ptr::null_mut());
                }
            }
            1 | 2 => set_state("connecting", None),
            _ => {
                if error != 0 {
                    set_state("error", Some(format!("connection {error}/{detail}")));
                    // An expired token closes the gateway; the sealed session is
                    // the way back without asking the person again.
                    reconnect_after_drop();
                } else {
                    set_state("idle", None);
                }
            }
        }
    }

    /// Starts (or restarts) the interactive flow: PKCE challenge, then the
    /// authorize prompt in the Discord client — or the browser when it is not
    /// running. Used on the first run and when a refresh fails.
    unsafe fn begin_authorize(client: *mut Client) {
        set_state("authorizing", None);
        let mut scopes = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        // The SDK's own communication scopes: friends, messages and voice
        // reads. The DM call endpoint wants a write scope this application may
        // not request, and asking caused an extra prompt for nothing, so the
        // call button stays out of the overlay.
        Discord_Client_GetDefaultCommunicationScopes(&mut scopes);
        let scopes_text = string_of(scopes);
        sdk_note!("requesting scopes: {scopes_text}");

        let mut verifier: CodeVerifier = std::mem::zeroed();
        Discord_Client_CreateAuthorizationCodeVerifier(client, &mut verifier);
        let mut challenge: CodeChallenge = std::mem::zeroed();
        Discord_AuthorizationCodeVerifier_Challenge(&mut verifier, &mut challenge);
        let mut verifier_text = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        Discord_AuthorizationCodeVerifier_Verifier(&mut verifier, &mut verifier_text);

        let mut args: AuthorizationArgs = std::mem::zeroed();
        Discord_AuthorizationArgs_Init(&mut args);
        Discord_AuthorizationArgs_SetClientId(&mut args, CLIENT_ID);
        Discord_AuthorizationArgs_SetScopes(&mut args, borrow_str(&scopes_text));
        Discord_AuthorizationArgs_SetCodeChallenge(&mut args, &mut challenge);

        let flow = Box::into_raw(Box::new(Flow {
            client,
            verifier: string_of(verifier_text),
        }));
        sdk_note!("asking for authorization (approve the prompt)");
        Discord_Client_Authorize(
            client,
            &mut args,
            on_authorized,
            None,
            flow as *mut Flow as *mut c_void,
        );
    }

    unsafe extern "C" fn on_authorized(
        result: *mut ClientResult,
        code: StringValue,
        redirect: StringValue,
        user: *mut c_void,
    ) {
        let flow = &mut *(user as *mut Flow);
        if !Discord_ClientResult_Successful(result) {
            let error = result_error(result);
            sdk_note!("authorize failed: {error}");
            set_state("error", Some(error));
            free_flow(user);
            return;
        }
        let code_text = string_of(code);
        let redirect_text = if redirect.size > 0 {
            string_of(redirect)
        } else {
            REDIRECT_HINT.to_string()
        };
        sdk_note!("authorization code received");
        // The SDK calls its callbacks from the pump thread, so nesting the
        // token exchange here is the documented pattern.
        Discord_Client_GetToken(
            flow.client,
            CLIENT_ID,
            borrow_str(&code_text),
            borrow_str(&flow.verifier),
            borrow_str(&redirect_text),
            on_token,
            None,
            user,
        );
    }

    /// The exchange result for both the code and the refresh paths: keep the
    /// session, then hand the access token to the client.
    unsafe extern "C" fn on_token(
        result: *mut ClientResult,
        access: StringValue,
        refresh: StringValue,
        _token_type: i32,
        expires_in: i32,
        scope: StringValue,
        user: *mut c_void,
    ) {
        let flow = &mut *(user as *mut Flow);
        if !Discord_ClientResult_Successful(result) {
            let error = result_error(result);
            let client = flow.client;
            sdk_note!("token exchange failed: {error}");
            free_flow(user);
            // A stored session that no longer refreshes falls back to the
            // prompt instead of leaving the panel stuck.
            sdk_note!("falling back to the authorization prompt");
            begin_authorize(client);
            return;
        }
        let access_text = string_of(access);
        let refresh_text = string_of(refresh);
        sdk_note!(
            "token received ({} bytes, refresh {} bytes, {expires_in}s, scope {})",
            access_text.len(),
            refresh_text.len(),
            string_of(scope)
        );
        if !refresh_text.is_empty() {
            let expires_at = now_secs() + expires_in.max(0) as u64;
            save_session(&SdkSession {
                access_token: access_text.clone(),
                refresh_token: refresh_text,
                expires_at: expires_at.saturating_sub(60),
            });
        }
        Discord_Client_UpdateToken(
            flow.client,
            1, // Bearer
            borrow_str(&access_text),
            on_token_updated,
            None,
            user,
        );
    }

    unsafe extern "C" fn on_token_updated(result: *mut ClientResult, user: *mut c_void) {
        let flow = &mut *(user as *mut Flow);
        if !Discord_ClientResult_Successful(result) {
            let error = result_error(result);
            sdk_note!("update token failed: {error}");
            set_state("error", Some(error));
            free_flow(user);
            return;
        }
        let client = flow.client;
        free_flow(user);
        sdk_note!("token set; connecting");
        set_state("connecting", None);
        Discord_Client_Connect(client);
    }

    /// The newest message id per conversation, so the summary poll only reports
    /// messages that arrived after the first look.
    static SEEN_SUMMARIES: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());
    /// Who the direct-message threads are with, straight from the SDK's own
    /// conversation list: that is what tells a DM apart from channel chatter.
    static DM_PARTNERS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
    /// The DM channel per friend (friend id -> channel id): starting a call
    /// needs the channel, and only a message carries it.
    static DM_CHANNELS: Mutex<Vec<(u64, u64)>> = Mutex::new(Vec::new());
    /// A call that is waiting for its channel: the history fetch fills
    /// `DM_CHANNELS`, and the pump then starts the call.
    static PENDING_CALL: Mutex<Option<u64>> = Mutex::new(None);
    /// Message ids already handed to the UI. The created callback and the
    /// summary poll both see the same message; it must land exactly once.
    static EMITTED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

    /// One message, read off its handle: exactly what the panel needs.
    struct MsgData {
        id: u64,
        author: u64,
        recipient: u64,
        channel_id: u64,
        text: String,
        attachment: String,
        sent_ms: u64,
    }

    /// Reads a message handle. The caller owns the handle and drops it.
    unsafe fn read_handle(handle: &mut MessageHandle) -> MsgData {
        let mut content = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        Discord_MessageHandle_Content(handle, &mut content);
        // An attachment (image, GIF, sticker) carries no text: its name is all
        // the row can show, but it must not vanish.
        let mut additional = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        let attachment = if Discord_MessageHandle_AdditionalName(handle, &mut additional) {
            string_of(additional)
        } else {
            String::new()
        };
        let sent = Discord_MessageHandle_SentTimestamp(handle);
        MsgData {
            id: Discord_MessageHandle_Id(handle),
            author: Discord_MessageHandle_AuthorId(handle),
            recipient: Discord_MessageHandle_RecipientId(handle),
            channel_id: Discord_MessageHandle_ChannelId(handle),
            text: string_of(content),
            attachment,
            // Some SDK builds report seconds; the UI wants milliseconds.
            sent_ms: if sent < 1_000_000_000_000 {
                sent * 1000
            } else {
                sent
            },
        }
    }

    /// Reads one message and hands it to the UI when it is a direct message to
    /// this account. Shared by the created callback and the summary poll, and
    /// it logs every skip so a quiet conversation can be diagnosed.
    unsafe fn emit_message_from(client: *mut Client, message_id: u64) {
        let mut handle: MessageHandle = std::mem::zeroed();
        if !Discord_Client_GetMessageHandle(client, message_id, &mut handle) {
            sdk_note!("message {message_id}: no handle");
            return;
        }
        let data = read_handle(&mut handle);
        Discord_MessageHandle_Drop(&mut handle);
        let author = data.author;
        let text = data.text;
        let attachment = data.attachment;
        let sent_ms = data.sent_ms;

        if text.is_empty() && attachment.is_empty() {
            sdk_note!("message {message_id}: empty content, skipped");
            return;
        }
        let Some(me_id) = with_state(|state| state.me.as_ref().map(|me| me.id.clone())).flatten() else {
            sdk_note!("message {message_id}: no signed-in account yet, skipped");
            return;
        };
        // Remember the DM channel id: starting a call needs it, and this is the
        // only place the SDK hands it out.
        if data.channel_id != 0 {
            let partner = if author.to_string() == me_id {
                data.recipient
            } else {
                author
            };
            if partner != 0 {
                if let Ok(mut map) = DM_CHANNELS.lock() {
                    match map.iter_mut().find(|(friend, _)| *friend == partner) {
                        Some(slot) => slot.1 = data.channel_id,
                        None => map.push((partner, data.channel_id)),
                    }
                }
            }
        }
        // Our own sends come back through the same path; everything else must
        // come from a direct-message thread the SDK listed for this account.
        if author.to_string() == me_id {
            return;
        }
        let known_partner = DM_PARTNERS
            .lock()
            .map(|partners| partners.is_empty() || partners.contains(&author))
            .unwrap_or(true);
        if !known_partner {
            // A friend's very first message arrives before the conversation
            // list has seen the thread; the friend list is the other proof that
            // this is a DM and not channel chatter.
            let is_friend = with_state(|state| {
                state
                    .friends
                    .iter()
                    .any(|friend| friend.id == author.to_string())
            })
            .unwrap_or(false);
            if !is_friend {
                sdk_note!("message {message_id}: author is not a DM partner, skipped");
                return;
            }
            if let Ok(mut partners) = DM_PARTNERS.lock() {
                if !partners.contains(&author) {
                    partners.push(author);
                }
            }
        }
        // The client replays history when it (re)connects: the log is "now".
        if sent_ms > 0 && now_secs() * 1000 > sent_ms + 120_000 {
            sdk_note!("message {message_id}: older than two minutes, skipped");
            return;
        }
        let duplicate = EMITTED
            .lock()
            .map(|seen| seen.contains(&message_id))
            .unwrap_or(false);
        if duplicate {
            return;
        }
        if let Ok(mut seen) = EMITTED.lock() {
            if seen.len() >= 200 {
                seen.remove(0);
            }
            seen.push(message_id);
        }
        sdk_note!("direct message received from {author}");
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "discord-sdk-message",
                serde_json::json!({
                    "friendId": author.to_string(),
                    "messageId": message_id.to_string(),
                    "text": text,
                    "attachment": attachment,
                    "at": sent_ms,
                }),
            );
        }
    }

    /// Someone deleted a message: the log drops the row if it showed it.
    unsafe extern "C" fn on_message_deleted(
        message_id: u64,
        _channel_id: u64,
        _user: *mut c_void,
    ) {
        sdk_note!("message {message_id} deleted");
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "discord-sdk-message-deleted",
                serde_json::json!({ "messageId": message_id.to_string() }),
            );
        }
    }

    /// The access token is about to expire: refresh from the sealed session so
    /// a long session never drops.
    unsafe extern "C" fn on_token_expiring(_user: *mut c_void) {
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() {
            return;
        }
        let Some(session) = APP_HANDLE.get().and_then(load_session) else {
            sdk_note!("token expiring but no stored session to refresh with");
            return;
        };
        sdk_note!("token expiring; refreshing the stored session");
        let flow = Box::into_raw(Box::new(Flow {
            client,
            verifier: String::new(),
        }));
        Discord_Client_RefreshToken(
            client,
            CLIENT_ID,
            borrow_str(&session.refresh_token),
            on_token,
            None,
            flow as *mut Flow as *mut c_void,
        );
    }

    /// The outcome of a delete the overlay asked for.
    unsafe extern "C" fn on_message_delete_result(result: *mut ClientResult, user: *mut c_void) {
        let ctx = &*(user as *mut SendCtx);
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!("direct message {} deleted", ctx.message_id);
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "messageId": ctx.message_id.to_string(),
                "ok": true,
            })
        } else {
            let error = result_error(result);
            sdk_note!("delete failed: {error}");
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "messageId": ctx.message_id.to_string(),
                "ok": false,
                "error": error,
            })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-dm-deleted", payload);
        }
    }

    /// The relationship list changed (a request accepted, a friend removed):
    /// re-read it so the panel matches Discord.
    unsafe extern "C" fn on_relationship_changed(
        _user_id: u64,
        _is_discord: bool,
        _user: *mut c_void,
    ) {
        read_social();
    }

    /// The outcome of accepting or rejecting a friend request.
    unsafe extern "C" fn on_relationship_result(result: *mut ClientResult, user: *mut c_void) {
        let ctx = &*(user as *mut RequestCtx);
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!(
                "friend request from {} {}",
                ctx.user_id,
                if ctx.accept { "accepted" } else { "rejected" }
            );
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "accept": ctx.accept,
                "ok": true,
            })
        } else {
            let error = result_error(result);
            sdk_note!("friend request failed: {error}");
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "accept": ctx.accept,
                "ok": false,
                "error": error,
            })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-request-done", payload);
        }
    }

    /// The outcome of an edit the overlay asked for.
    unsafe extern "C" fn on_message_edit_result(result: *mut ClientResult, user: *mut c_void) {
        let ctx = &*(user as *mut EditCtx);
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!("direct message {} edited", ctx.message_id);
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "messageId": ctx.message_id.to_string(),
                "text": ctx.text,
                "ok": true,
            })
        } else {
            let error = result_error(result);
            sdk_note!("edit failed: {error}");
            serde_json::json!({
                "userId": ctx.user_id.to_string(),
                "messageId": ctx.message_id.to_string(),
                "ok": false,
                "error": error,
            })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-dm-edited", payload);
        }
    }

    /// A direct message that arrived while the overlay is open.
    unsafe extern "C" fn on_message_created(message_id: u64, _user: *mut c_void) {
        sdk_note!("message created callback: {message_id}");
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() {
            return;
        }
        emit_message_from(client, message_id);
    }

    /// The conversation list, polled while connected. The first pass only
    /// records where each conversation stands; later passes report the newest
    /// message of any conversation that moved past it.
    unsafe extern "C" fn on_summaries(
        result: *mut ClientResult,
        summaries: UserMessageSummarySpan,
        _user: *mut c_void,
    ) {
        if !Discord_ClientResult_Successful(result) {
            sdk_note!("summaries failed: {}", result_error(result));
            return;
        }
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() || summaries.ptr.is_null() {
            return;
        }
        let primed = with_seen(|seen| !seen.is_empty()).unwrap_or(false);
        let mut fresh: Vec<u64> = Vec::new();
        for index in 0..summaries.size {
            let mut summary = *summaries.ptr.add(index);
            let user_id = Discord_UserMessageSummary_UserId(&mut summary);
            let last_id = Discord_UserMessageSummary_LastMessageId(&mut summary);
            Discord_UserMessageSummary_Drop(&mut summary);
            if user_id == 0 || last_id == 0 {
                continue;
            }
            let known = with_seen(|seen| {
                seen.iter()
                    .find(|(id, _)| *id == user_id)
                    .map(|(_, last)| *last)
            })
            .flatten();
            with_seen(|seen| {
                match seen.iter_mut().find(|(id, _)| *id == user_id) {
                    Some(slot) => slot.1 = last_id,
                    None => seen.push((user_id, last_id)),
                }
            });
            if let Ok(mut partners) = DM_PARTNERS.lock() {
                if !partners.contains(&user_id) {
                    partners.push(user_id);
                }
            }
            // Only a conversation that moved forward carries a new message; the
            // first pass is the baseline, so a fresh session stays quiet. A
            // thread that was not in the baseline at all is new: its latest
            // message is the one that matters.
            if primed && known.map(|last| last_id > last).unwrap_or(true) {
                fresh.push(last_id);
            }
        }
        if !primed {
            sdk_note!("conversation list primed ({} threads)", summaries.size);
            return;
        }
        for message_id in fresh {
            emit_message_from(client, message_id);
        }
    }

    unsafe fn with_seen<T>(f: impl FnOnce(&mut Vec<(u64, u64)>) -> T) -> Option<T> {
        let mut guard = SEEN_SUMMARIES.lock().ok()?;
        Some(f(&mut guard))
    }

    /// A call that was waiting for the history gives up when the history cannot
    /// hand a channel over: the panel must hear about it instead of spinning.
    unsafe fn fail_pending_call(friend_id: u64, reason: &str) {
        let waiting = PENDING_CALL.lock().ok().and_then(|guard| *guard);
        if waiting != Some(friend_id) {
            return;
        }
        if let Ok(mut guard) = PENDING_CALL.lock() {
            *guard = None;
        }
        sdk_note!("call: giving up for {friend_id} ({reason})");
        emit_call("idle", friend_id, false, Some(reason.to_string()));
    }

    /// The last messages of one conversation, so the panel opens with real
    /// history instead of an empty log.
    unsafe extern "C" fn on_history(
        result: *mut ClientResult,
        messages: MessageHandleSpan,
        user: *mut c_void,
    ) {
        let ctx = &*(user as *mut SendCtx);
        if !Discord_ClientResult_Successful(result) {
            sdk_note!("history failed: {}", result_error(result));
            fail_pending_call(ctx.user_id, "history_failed");
            return;
        }
        if messages.ptr.is_null() || messages.size == 0 {
            // A thread with no messages has no channel id to hand over, so a
            // call waiting on it would never start.
            fail_pending_call(ctx.user_id, "no_channel");
            return;
        }
        let me_id = with_state(|state| state.me.as_ref().map(|me| me.id.clone())).flatten();
        let mut rows: Vec<serde_json::Value> = Vec::new();
        for index in 0..messages.size {
            let mut handle = *messages.ptr.add(index);
            let data = read_handle(&mut handle);
            Discord_MessageHandle_Drop(&mut handle);
            if data.text.is_empty() && data.attachment.is_empty() {
                continue;
            }
            let mine = me_id.as_deref() == Some(data.author.to_string().as_str());
            // Messages carry the DM channel id: remember it so a call can start.
            if data.channel_id != 0 {
                let partner = if mine { data.recipient } else { data.author };
                if partner != 0 {
                    if let Ok(mut map) = DM_CHANNELS.lock() {
                        match map.iter_mut().find(|(friend, _)| *friend == partner) {
                            Some(slot) => slot.1 = data.channel_id,
                            None => map.push((partner, data.channel_id)),
                        }
                    }
                }
            }
            rows.push(serde_json::json!({
                "messageId": data.id.to_string(),
                "text": data.text,
                "attachment": data.attachment,
                "at": data.sent_ms,
                "direction": if mine { "out" } else { "in" },
            }));
        }
        sdk_note!("history for {}: {} messages", ctx.user_id, rows.len());
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "discord-sdk-history",
                serde_json::json!({
                    "friendId": ctx.user_id.to_string(),
                    "messages": rows,
                }),
            );
        }
    }


    unsafe extern "C" fn on_message_sent(
        result: *mut ClientResult,
        message_id: u64,
        user: *mut c_void,
    ) {
        let ctx = &*(user as *mut SendCtx);
        let user_id = ctx.user_id.to_string();
        let payload = if Discord_ClientResult_Successful(result) {
            sdk_note!("direct message sent (id {message_id})");
            serde_json::json!({ "userId": user_id, "ok": true, "messageId": message_id.to_string() })
        } else {
            let error = result_error(result);
            sdk_note!("send failed: {error}");
            serde_json::json!({ "userId": user_id, "ok": false, "error": error })
        };
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("discord-sdk-dm", payload);
        }
    }

    /// The relationship type as the UI's status words (see `Discord_StatusType`).
    fn status_word(status: i32) -> &'static str {
        match status {
            0 | 6 => "online",
            3 => "idle",
            4 => "dnd",
            _ => "offline",
        }
    }

    fn handle_name(handle: &mut UserHandle) -> String {
        let mut name = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        unsafe { Discord_UserHandle_DisplayName(handle, &mut name) };
        string_of(name)
    }

    fn handle_avatar(handle: &mut UserHandle, user_id: u64) -> String {
        let mut hash = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        if unsafe { Discord_UserHandle_Avatar(handle, &mut hash) } {
            let text = string_of(hash);
            if !text.is_empty() {
                return crate::discord_rpc::avatar_url(&user_id.to_string(), &text);
            }
        }
        String::new()
    }

    /// Reads the account and the relationships, stores them for the panel and
    /// pushes both events. Runs on the pump thread, like every other callback.
    unsafe fn read_social() {
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() {
            return;
        }
        let mut me_handle: UserHandle = std::mem::zeroed();
        let me = if Discord_Client_GetCurrentUserV2(client, &mut me_handle) {
            let id = Discord_UserHandle_Id(&mut me_handle);
            let entry = SdkMe {
                id: id.to_string(),
                name: handle_name(&mut me_handle),
                avatar_url: handle_avatar(&mut me_handle, id),
                status: status_word(Discord_UserHandle_Status(&mut me_handle)).to_string(),
            };
            Discord_UserHandle_Drop(&mut me_handle);
            Some(entry)
        } else {
            None
        };

        let mut span = RelationshipSpan {
            ptr: ptr::null_mut(),
            size: 0,
        };
        Discord_Client_GetRelationships(client, &mut span);
        let mut friends: Vec<SdkFriend> = Vec::new();
        let mut pending_users: Vec<SdkFriend> = Vec::new();
        let mut pending = 0u32;
        let mut blocked = 0u32;
        if !span.ptr.is_null() {
            for index in 0..span.size {
                let mut handle = *span.ptr.add(index);
                let kind = Discord_RelationshipHandle_DiscordRelationshipType(&mut handle);
                match kind {
                    // 1 = friend, 3 = an incoming request: both carry a user we
                    // show, and the request is what the panel can accept.
                    1 | 3 => {
                        let user_id = Discord_RelationshipHandle_Id(&mut handle);
                        let mut user: UserHandle = std::mem::zeroed();
                        if Discord_Client_GetUser(client, user_id, &mut user) {
                            let entry = SdkFriend {
                                id: user_id.to_string(),
                                name: handle_name(&mut user),
                                avatar_url: handle_avatar(&mut user, user_id),
                                status: status_word(Discord_UserHandle_Status(&mut user)).to_string(),
                            };
                            Discord_UserHandle_Drop(&mut user);
                            if kind == 1 {
                                friends.push(entry);
                            } else {
                                pending += 1;
                                pending_users.push(entry);
                            }
                        }
                    }
                    2 => blocked += 1,
                    4 => pending += 1,
                    _ => {}
                }
            }
        }
        // Online first, then by name: the panel shows the first rows it gets.
        friends.sort_by(|a, b| {
            (a.status == "offline")
                .cmp(&(b.status == "offline"))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let sample = friends
            .first()
            .map(|friend| {
                format!(
                    "first friend: {} ({})",
                    crate::discord_rpc::mask_name(&friend.name),
                    friend.id
                )
            })
            .unwrap_or_default();
        sdk_note!("relationships: {} friends, {pending} pending, {blocked} blocked", friends.len());
        if !sample.is_empty() {
            sdk_note!("{sample}");
        }
        with_state(|state| {
            state.me = me;
            state.friends = friends;
            state.pending_users = pending_users;
            state.pending = pending;
        });
        emit_state();
        emit_friends();
    }

    /// Owns the client for the whole app run: resume or authorize once, then
    /// pump the SDK's callbacks and serve the command queue until the app exits.
    pub fn run(app: AppHandle, rx: Receiver<SdkCommand>, silent: bool) {
        unsafe {
            let mut client: Client = std::mem::zeroed();
            Discord_Client_Init(&mut client);
            let client_ptr = &mut client as *mut Client;
            super::CLIENT_PTR.store(client_ptr, Ordering::SeqCst);
            sdk_note!("client initialized");

            Discord_Client_AddLogCallback(&mut client, on_log, None, ptr::null_mut(), 2);
            Discord_Client_SetStatusChangedCallback(&mut client, on_status, None, ptr::null_mut());
            Discord_Client_SetMessageCreatedCallback(
                &mut client,
                on_message_created,
                None,
                ptr::null_mut(),
            );
            Discord_Client_SetMessageDeletedCallback(
                &mut client,
                on_message_deleted,
                None,
                ptr::null_mut(),
            );
            Discord_Client_SetTokenExpirationCallback(
                &mut client,
                on_token_expiring,
                None,
                ptr::null_mut(),
            );
            Discord_Client_SetRelationshipCreatedCallback(
                &mut client,
                on_relationship_changed,
                None,
                ptr::null_mut(),
            );
            Discord_Client_SetRelationshipDeletedCallback(
                &mut client,
                on_relationship_changed,
                None,
                ptr::null_mut(),
            );

            match load_session(&app) {
                Some(session) => {
                    sdk_note!(
                        "resuming the stored session ({} bytes refresh, {}s left on the access token)",
                        session.refresh_token.len(),
                        session.expires_at.saturating_sub(now_secs())
                    );
                    set_state("connecting", None);
                    let flow = Box::into_raw(Box::new(Flow {
                        client: client_ptr,
                        verifier: String::new(),
                    }));
                    Discord_Client_RefreshToken(
                        client_ptr,
                        CLIENT_ID,
                        borrow_str(&session.refresh_token),
                        on_token,
                        None,
                        flow as *mut Flow as *mut c_void,
                    );
                }
                None => {
                    if silent {
                        // Nothing to resume and nobody asked: the panel shows
                        // the Connect button instead of an unasked prompt.
                        sdk_note!("no stored session; waiting for the Connect button");
                        set_state("idle", None);
                    } else {
                        sdk_note!("no stored session");
                        begin_authorize(client_ptr);
                    }
                }
            }

            // The pump: the SDK needs RunCallbacks every few milliseconds; the
            // queue carries the composer's sends and a slow poll watches the
            // conversation list for messages that arrived.
            let mut next_poll = Instant::now();
            let mut active_call: Option<Call> = None;
            let mut call_friend: u64 = 0;
            loop {
                Discord_RunCallbacks();
                loop {
                    match rx.try_recv() {
                        Ok(SdkCommand::SendDm { user_id, text }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("send ignored: not connected");
                                if let Some(app) = APP_HANDLE.get() {
                                    let _ = app.emit(
                                        "discord-sdk-dm",
                                        serde_json::json!({
                                            "userId": user_id.to_string(),
                                            "ok": false,
                                            "error": "not_ready",
                                        }),
                                    );
                                }
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(SendCtx {
                                user_id,
                                message_id: 0,
                            }));
                            Discord_Client_SendUserMessage(
                                client_ptr,
                                user_id,
                                borrow_str(&text),
                                on_message_sent,
                                Some(free_send),
                                ctx as *mut SendCtx as *mut c_void,
                            );
                        }
                        Ok(SdkCommand::Call { user_id }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("call ignored: not connected");
                                emit_call("idle", user_id, false, Some("not_ready".to_string()));
                                continue;
                            }
                            let channel = DM_CHANNELS.lock().ok().and_then(|map| {
                                map.iter()
                                    .find(|(friend, _)| *friend == user_id)
                                    .map(|(_, channel)| *channel)
                            });
                            let Some(channel) = channel else {
                                // The channel id is only carried by messages, so
                                // ask for the history; the pump starts the call
                                // the moment the id is known.
                                sdk_note!("call: no DM channel for {user_id} yet; asking for the history");
                                if let Ok(mut guard) = PENDING_CALL.lock() {
                                    *guard = Some(user_id);
                                }
                                let ctx = Box::into_raw(Box::new(SendCtx {
                                    user_id,
                                    message_id: 0,
                                }));
                                Discord_Client_GetUserMessagesWithLimit(
                                    client_ptr,
                                    user_id,
                                    30,
                                    on_history,
                                    Some(free_send),
                                    ctx as *mut SendCtx as *mut c_void,
                                );
                                continue;
                            };
                            // One call at a time: a second one replaces the
                            // first instead of leaking its handle. The handle is
                            // not dropped — the SDK still owns the call object
                            // until the end callback lands.
                            if let Some(mut previous) = active_call.take() {
                                let previous_channel = Discord_Call_GetChannelId(&mut previous);
                                Discord_Client_EndCall(
                                    client_ptr,
                                    previous_channel,
                                    on_call_ended,
                                    None,
                                    ptr::null_mut(),
                                );
                                sdk_note!("call: ended the previous call in channel {previous_channel}");
                            }
                            let mut call: Call = std::mem::zeroed();
                            if Discord_Client_StartCall(client_ptr, channel, &mut call) {
                                sdk_note!("call started in channel {channel}");
                                active_call = Some(call);
                                call_friend = user_id;
                                emit_call("active", user_id, false, None);
                            } else {
                                sdk_note!("call could not start");
                                emit_call("idle", user_id, false, Some("call_failed".to_string()));
                            }
                        }
                        Ok(SdkCommand::Hangup) => {
                            if let Some(mut call) = active_call.take() {
                                let channel = Discord_Call_GetChannelId(&mut call);
                                Discord_Client_EndCall(
                                    client_ptr,
                                    channel,
                                    on_call_ended,
                                    None,
                                    ptr::null_mut(),
                                );
                                sdk_note!("call ended in channel {channel}");
                                emit_call("idle", call_friend, false, None);
                                call_friend = 0;
                            }
                        }
                        Ok(SdkCommand::CallMute { mute }) => {
                            if let Some(mut call) = active_call {
                                Discord_Call_SetSelfMute(&mut call, mute);
                                sdk_note!("call mute: {mute}");
                                emit_call("active", call_friend, mute, None);
                            }
                        }
                        Ok(SdkCommand::SetStatus { code, label }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("status change ignored: not connected");
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(StatusCtx { label }));
                            Discord_Client_SetOnlineStatus(
                                client_ptr,
                                code,
                                on_status_result,
                                Some(free_status),
                                ctx as *mut StatusCtx as *mut c_void,
                            );
                        }
                        Ok(SdkCommand::Channels) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if ready {
                                Discord_Client_GetUserGuilds(
                                    client_ptr,
                                    on_guilds,
                                    None,
                                    ptr::null_mut(),
                                );
                            }
                        }
                        Ok(SdkCommand::Search { query }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("search ignored: not connected");
                                continue;
                            }
                            let mut span = UserHandleSpan {
                                ptr: ptr::null_mut(),
                                size: 0,
                            };
                            Discord_Client_SearchFriendsByUsername(
                                client_ptr,
                                borrow_str(&query),
                                &mut span,
                            );
                            let mut users: Vec<serde_json::Value> = Vec::new();
                            if !span.ptr.is_null() {
                                for index in 0..span.size {
                                    let mut handle = *span.ptr.add(index);
                                    let id = Discord_UserHandle_Id(&mut handle);
                                    let name = handle_name(&mut handle);
                                    let avatar_url = handle_avatar(&mut handle, id);
                                    let mut username = StringValue {
                                        ptr: ptr::null_mut(),
                                        size: 0,
                                    };
                                    Discord_UserHandle_Username(&mut handle, &mut username);
                                    Discord_UserHandle_Drop(&mut handle);
                                    users.push(serde_json::json!({
                                        "id": id.to_string(),
                                        "name": name,
                                        "username": string_of(username),
                                        "avatarUrl": avatar_url,
                                    }));
                                }
                            }
                            sdk_note!("search \"{query}\": {} users", users.len());
                            if let Some(app) = APP_HANDLE.get() {
                                let _ = app.emit(
                                    "discord-sdk-search",
                                    serde_json::json!({ "query": query, "users": users }),
                                );
                            }
                        }
                        Ok(SdkCommand::AddFriend { username }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("friend request ignored: not connected");
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(AddFriendCtx {
                                username: username.clone(),
                            }));
                            Discord_Client_SendDiscordFriendRequest(
                                client_ptr,
                                borrow_str(&username),
                                on_friend_request_sent,
                                Some(free_add_friend),
                                ctx as *mut AddFriendCtx as *mut c_void,
                            );
                        }
                        Ok(SdkCommand::History { user_id, limit }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("history ignored: not connected");
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(SendCtx {
                                user_id,
                                message_id: 0,
                            }));
                            Discord_Client_GetUserMessagesWithLimit(
                                client_ptr,
                                user_id,
                                limit,
                                on_history,
                                Some(free_send),
                                ctx as *mut SendCtx as *mut c_void,
                            );
                        }
                        Ok(SdkCommand::FriendRequest { user_id, accept }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("friend request ignored: not connected");
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(RequestCtx { user_id, accept }));
                            let user_data = ctx as *mut RequestCtx as *mut c_void;
                            if accept {
                                Discord_Client_AcceptDiscordFriendRequest(
                                    client_ptr,
                                    user_id,
                                    on_relationship_result,
                                    Some(free_request),
                                    user_data,
                                );
                            } else {
                                Discord_Client_RejectDiscordFriendRequest(
                                    client_ptr,
                                    user_id,
                                    on_relationship_result,
                                    Some(free_request),
                                    user_data,
                                );
                            }
                        }
                        Ok(SdkCommand::EditDm {
                            user_id,
                            message_id,
                            text,
                        }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("edit ignored: not connected");
                                continue;
                            }
                            let edit = EditCtx {
                                user_id,
                                message_id,
                                text,
                            };
                            // The borrow ends here; the box keeps the text alive
                            // for the SDK call.
                            let content = borrow_str(&edit.text);
                            let ctx = Box::into_raw(Box::new(edit));
                            Discord_Client_EditUserMessage(
                                client_ptr,
                                user_id,
                                message_id,
                                content,
                                on_message_edit_result,
                                Some(free_edit),
                                ctx as *mut EditCtx as *mut c_void,
                            );
                        }
                        Ok(SdkCommand::DeleteDm {
                            user_id,
                            message_id,
                        }) => {
                            let ready =
                                with_state(|state| state.status == "ready").unwrap_or(false);
                            if !ready {
                                sdk_note!("delete ignored: not connected");
                                continue;
                            }
                            let ctx = Box::into_raw(Box::new(SendCtx {
                                user_id,
                                message_id,
                            }));
                            Discord_Client_DeleteUserMessage(
                                client_ptr,
                                user_id,
                                message_id,
                                on_message_delete_result,
                                Some(free_send),
                                ctx as *mut SendCtx as *mut c_void,
                            );
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => return,
                    }
                }
                if Instant::now() >= next_poll {
                    next_poll = Instant::now() + Duration::from_secs(5);
                    let ready = with_state(|state| state.status == "ready").unwrap_or(false);
                    if ready {
                        Discord_Client_GetUserMessageSummaries(
                            client_ptr,
                            on_summaries,
                            None,
                            ptr::null_mut(),
                        );
                    }
                }
                // A call waiting for its channel starts as soon as the history
                // fetch has handed the id over.
                let waiting = PENDING_CALL.lock().ok().and_then(|guard| *guard);
                if let Some(friend) = waiting {
                    let channel = DM_CHANNELS.lock().ok().and_then(|map| {
                        map.iter()
                            .find(|(entry, _)| *entry == friend)
                            .map(|(_, channel)| *channel)
                    });
                    if let Some(channel) = channel {
                        if let Ok(mut guard) = PENDING_CALL.lock() {
                            *guard = None;
                        }
                        if let Some(mut previous) = active_call.take() {
                            let previous_channel = Discord_Call_GetChannelId(&mut previous);
                            Discord_Client_EndCall(
                                client_ptr,
                                previous_channel,
                                on_call_ended,
                                None,
                                ptr::null_mut(),
                            );
                        }
                        let mut call: Call = std::mem::zeroed();
                        if Discord_Client_StartCall(client_ptr, channel, &mut call) {
                            sdk_note!("call started in channel {channel} (waited for the id)");
                            active_call = Some(call);
                            call_friend = friend;
                            emit_call("active", friend, false, None);
                        } else {
                            sdk_note!("call could not start after the wait");
                            emit_call("idle", friend, false, Some("call_failed".to_string()));
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

#[cfg(discord_sdk)]
fn worker(app: AppHandle, rx: Receiver<SdkCommand>, silent: bool) {
    imp::run(app, rx, silent);
}

#[cfg(not(discord_sdk))]
fn worker(_app: AppHandle, _rx: Receiver<SdkCommand>, _silent: bool) {
    sdk_log("SDK not vendored; nothing to run");
    set_state("error", Some("sdk_not_vendored".to_string()));
}
