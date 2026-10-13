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
}

/// The signed-in account, as the composer header shows it.
#[derive(Clone)]
struct SdkMe {
    id: String,
    name: String,
    avatar_url: String,
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
    pending: u32,
}

impl SdkState {
    const fn new() -> Self {
        Self {
            status: String::new(),
            error: None,
            me: None,
            friends: Vec::new(),
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
#[tauri::command]
pub fn discord_sdk_start(app: AppHandle) -> Result<(), String> {
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
        .spawn(move || worker(app, rx));
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
    pub type UserMessageSummariesCallback =
        unsafe extern "C" fn(*mut ClientResult, UserMessageSummarySpan, *mut c_void);

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
        pub fn Discord_Client_GetMessageHandle(
            client: *mut Client,
            message_id: u64,
            out: *mut MessageHandle,
        ) -> bool;
        pub fn Discord_MessageHandle_Content(handle: *mut MessageHandle, out: *mut StringValue);
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

    /// The recipient of an in-flight send, handed to the completion callback.
    struct SendCtx {
        user_id: u64,
    }

    unsafe extern "C" fn free_flow(user: *mut c_void) {
        drop(Box::from_raw(user as *mut Flow));
    }

    unsafe extern "C" fn free_send(user: *mut c_void) {
        drop(Box::from_raw(user as *mut SendCtx));
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
            }
            1 | 2 => set_state("connecting", None),
            _ => {
                if error != 0 {
                    set_state("error", Some(format!("connection {error}/{detail}")));
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
        Discord_Client_GetDefaultCommunicationScopes(&mut scopes);
        let scopes_text = string_of(scopes);

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

    /// Reads one message and hands it to the UI when it is a direct message to
    /// this account. Shared by the created callback and the summary poll, and
    /// it logs every skip so a quiet conversation can be diagnosed.
    unsafe fn emit_message_from(client: *mut Client, message_id: u64) {
        let mut handle: MessageHandle = std::mem::zeroed();
        if !Discord_Client_GetMessageHandle(client, message_id, &mut handle) {
            sdk_note!("message {message_id}: no handle");
            return;
        }
        let mut content = StringValue {
            ptr: ptr::null_mut(),
            size: 0,
        };
        Discord_MessageHandle_Content(&mut handle, &mut content);
        let text = string_of(content);
        let author = Discord_MessageHandle_AuthorId(&mut handle);
        let recipient = Discord_MessageHandle_RecipientId(&mut handle);
        let sent = Discord_MessageHandle_SentTimestamp(&mut handle);
        Discord_MessageHandle_Drop(&mut handle);

        if text.is_empty() {
            sdk_note!("message {message_id}: empty content, skipped");
            return;
        }
        let Some(me_id) = with_state(|state| state.me.as_ref().map(|me| me.id.clone())).flatten() else {
            sdk_note!("message {message_id}: no signed-in account yet, skipped");
            return;
        };
        // Our own sends come back through the same path; and anything that is
        // not a direct message to this account has no thread to land in.
        if author.to_string() == me_id {
            return;
        }
        if recipient != 0 && recipient.to_string() != me_id {
            sdk_note!("message {message_id}: not a direct message to this account, skipped");
            return;
        }
        // The client replays history when it (re)connects: the log is "now".
        let sent_ms = if sent < 1_000_000_000_000 { sent * 1000 } else { sent };
        if sent_ms > 0 && now_secs() * 1000 > sent_ms + 120_000 {
            sdk_note!("message {message_id}: older than two minutes, skipped");
            return;
        }
        sdk_note!("direct message received from {author}");
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "discord-sdk-message",
                serde_json::json!({
                    "friendId": author.to_string(),
                    "text": text,
                    "at": sent_ms,
                }),
            );
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
            // Only a conversation that moved forward carries a new message; the
            // first pass is the baseline, so a fresh session stays quiet.
            if primed && known.map(|last| last_id > last).unwrap_or(false) {
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
        let mut pending = 0u32;
        let mut blocked = 0u32;
        if !span.ptr.is_null() {
            for index in 0..span.size {
                let mut handle = *span.ptr.add(index);
                let kind = Discord_RelationshipHandle_DiscordRelationshipType(&mut handle);
                match kind {
                    1 => {
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
                            friends.push(entry);
                        }
                    }
                    2 => blocked += 1,
                    3 | 4 => pending += 1,
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
            state.pending = pending;
        });
        emit_state();
        emit_friends();
    }

    /// Owns the client for the whole app run: resume or authorize once, then
    /// pump the SDK's callbacks and serve the command queue until the app exits.
    pub fn run(app: AppHandle, rx: Receiver<SdkCommand>) {
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
                    sdk_note!("no stored session");
                    begin_authorize(client_ptr);
                }
            }

            // The pump: the SDK needs RunCallbacks every few milliseconds; the
            // queue carries the composer's sends and a slow poll watches the
            // conversation list for messages that arrived.
            let mut next_poll = Instant::now();
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
                            let ctx = Box::into_raw(Box::new(SendCtx { user_id }));
                            Discord_Client_SendUserMessage(
                                client_ptr,
                                user_id,
                                borrow_str(&text),
                                on_message_sent,
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
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

#[cfg(discord_sdk)]
fn worker(app: AppHandle, rx: Receiver<SdkCommand>) {
    imp::run(app, rx);
}

#[cfg(not(discord_sdk))]
fn worker(_app: AppHandle, _rx: Receiver<SdkCommand>) {
    sdk_log("SDK not vendored; nothing to run");
    set_state("error", Some("sdk_not_vendored".to_string()));
}
