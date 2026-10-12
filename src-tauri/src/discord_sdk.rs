//! Discord Social SDK spike (Faz 4b): proves the official **write** path.
//!
//! The C API from `discord_partner_sdk.dll` is bound by hand; every handle the
//! SDK hands out is one opaque pointer, which keeps the bindings exact. A
//! single worker thread owns the client, pumps `Discord_RunCallbacks` (the
//! SDK's callback loop) and drains a command queue, so the client is only ever
//! touched from one thread — the same shape `presence.rs` uses.
//!
//! The flow follows the documented quick start: Authorize (PKCE) → GetToken →
//! UpdateToken → Connect → read the relationships. `Discord_Client_SendUserMessage`
//! proves the write path the overlay composer will use.
//!
//! Everything lands in the shared Discord log (`[discord-sdk]` lines) so a
//! failed step reads like the rest of the integration. Without the vendored SDK
//! (see `build.rs`) every command here is a no-op, so the build never depends
//! on the 745 MB download.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;

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
/// The app handle for logging; set before the worker starts.
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[cfg(discord_sdk)]
static CLIENT_PTR: std::sync::atomic::AtomicPtr<ffi::Client> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

enum SdkCommand {
    SendDm { user_id: u64, text: String },
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

/// Starts the spike: initializes the client, runs the authorize flow and pumps
/// the SDK until the app exits. Dev builds only (like the other dev probes).
#[tauri::command]
pub fn discord_sdk_spike(app: AppHandle) {
    #[cfg(debug_assertions)]
    {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = APP_HANDLE.set(app.clone());
        let (tx, rx) = channel::<SdkCommand>();
        if let Ok(mut guard) = COMMANDS.lock() {
            *guard = Some(tx);
        }
        let spawned = std::thread::Builder::new()
            .name("discord-sdk".to_string())
            .spawn(move || worker(app, rx));
        if spawned.is_err() {
            sdk_log("worker could not start");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}

/// Sends a direct message through the SDK (the composer's path). The `user_id`
/// is a Discord snowflake; the worker owns the actual call.
#[tauri::command]
pub fn discord_sdk_send_dm(user_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty_message".to_string());
    }
    let id = user_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "bad_user_id".to_string())?;
    let guard = COMMANDS.lock().map_err(|_| "worker_gone".to_string())?;
    let Some(sender) = guard.as_ref() else {
        return Err("spike_not_started".to_string());
    };
    sender
        .send(SdkCommand::SendDm {
            user_id: id,
            text,
        })
        .map_err(|_| "worker_gone".to_string())
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

    #[repr(C)]
    pub struct RelationshipSpan {
        pub ptr: *mut RelationshipHandle,
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
        pub fn Discord_Client_UpdateToken(
            client: *mut Client,
            token_type: i32,
            token: StringValue,
            callback: UpdateTokenCallback,
            free: Option<FreeFn>,
            user_data: *mut c_void,
        );
        pub fn Discord_Client_Connect(client: *mut Client);
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

    /// What the authorize chain needs while the SDK calls us back.
    struct Flow {
        client: *mut Client,
        verifier: String,
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

    /// Ready means the client is connected and authenticated; that is when the
    /// relationships are worth reading.
    unsafe extern "C" fn on_status(status: i32, error: i32, detail: i32, _user: *mut c_void) {
        sdk_note!("status {status} (error {error}/{detail})");
        if status == 3 {
            dump_relationships();
        }
    }

    unsafe extern "C" fn on_authorized(
        result: *mut ClientResult,
        code: StringValue,
        redirect: StringValue,
        user: *mut c_void,
    ) {
        let flow = &mut *(user as *mut Flow);
        if !Discord_ClientResult_Successful(result) {
            sdk_note!("authorize failed: {}", result_error(result));
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
            flow as *mut Flow as *mut c_void,
        );
    }

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
            sdk_note!("token exchange failed: {}", result_error(result));
            return;
        }
        let access_text = string_of(access);
        sdk_note!(
            "token received ({} bytes, refresh {} bytes, {expires_in}s, scope {})",
            access_text.len(),
            string_of(refresh).len(),
            string_of(scope)
        );
        Discord_Client_UpdateToken(
            flow.client,
            1, // Bearer
            borrow_str(&access_text),
            on_token_updated,
            None,
            flow as *mut Flow as *mut c_void,
        );
    }

    unsafe extern "C" fn on_token_updated(result: *mut ClientResult, user: *mut c_void) {
        let flow = &mut *(user as *mut Flow);
        if !Discord_ClientResult_Successful(result) {
            sdk_note!("update token failed: {}", result_error(result));
            return;
        }
        sdk_note!("token set; connecting");
        Discord_Client_Connect(flow.client);
    }

    unsafe extern "C" fn on_message_sent(
        result: *mut ClientResult,
        message_id: u64,
        _user: *mut c_void,
    ) {
        if Discord_ClientResult_Successful(result) {
            sdk_note!("direct message sent (id {message_id})");
        } else {
            sdk_note!("send failed: {}", result_error(result));
        }
    }

    /// Reads the relationships and logs a count with one masked sample, so the
    /// official friends path is proven like the page-based one.
    unsafe fn dump_relationships() {
        let client = super::CLIENT_PTR.load(Ordering::SeqCst);
        if client.is_null() {
            return;
        }
        let mut span = RelationshipSpan {
            ptr: ptr::null_mut(),
            size: 0,
        };
        Discord_Client_GetRelationships(client, &mut span);
        if span.ptr.is_null() || span.size == 0 {
            sdk_note!("relationships: none");
            return;
        }
        let handles = span.ptr;
        let count = span.size;
        let mut friends = 0usize;
        let mut pending = 0usize;
        let mut blocked = 0usize;
        let mut sample = String::new();
        for index in 0..count {
            let mut handle = *handles.add(index);
            let kind = Discord_RelationshipHandle_DiscordRelationshipType(&mut handle);
            match kind {
                1 => {
                    friends += 1;
                    if sample.is_empty() {
                        let user_id = Discord_RelationshipHandle_Id(&mut handle);
                        let mut user: UserHandle = std::mem::zeroed();
                        if Discord_Client_GetUser(client, user_id, &mut user) {
                            let mut name = StringValue {
                                ptr: ptr::null_mut(),
                                size: 0,
                            };
                            Discord_UserHandle_DisplayName(&mut user, &mut name);
                            sample = format!(
                                "first friend: {} ({user_id})",
                                crate::discord_rpc::mask_name(&string_of(name))
                            );
                        }
                    }
                }
                2 => blocked += 1,
                3 | 4 => pending += 1,
                _ => {}
            }
        }
        sdk_note!(
            "relationships: {friends} friends, {pending} pending, {blocked} blocked"
        );
        if !sample.is_empty() {
            sdk_note!("{sample}");
        }
    }

    /// Owns the client for the whole app run: authorize once, then pump the
    /// SDK's callbacks and serve the command queue.
    pub fn run(_app: AppHandle, rx: Receiver<SdkCommand>) {
        unsafe {
            let mut client: Client = std::mem::zeroed();
            Discord_Client_Init(&mut client);
            let client_ptr = &mut client as *mut Client;
            super::CLIENT_PTR.store(client_ptr, Ordering::SeqCst);
            sdk_note!("client initialized");

            Discord_Client_AddLogCallback(&mut client, on_log, None, ptr::null_mut(), 2);
            Discord_Client_SetStatusChangedCallback(
                &mut client,
                on_status,
                None,
                ptr::null_mut(),
            );

            let mut scopes = StringValue {
                ptr: ptr::null_mut(),
                size: 0,
            };
            Discord_Client_GetDefaultCommunicationScopes(&mut scopes);
            let scopes_text = string_of(scopes);
            sdk_note!("communication scopes: {scopes_text}");

            let mut verifier: CodeVerifier = std::mem::zeroed();
            Discord_Client_CreateAuthorizationCodeVerifier(&mut client, &mut verifier);
            let mut challenge: CodeChallenge = std::mem::zeroed();
            Discord_AuthorizationCodeVerifier_Challenge(&mut verifier, &mut challenge);
            let mut verifier_text = StringValue {
                ptr: ptr::null_mut(),
                size: 0,
            };
            Discord_AuthorizationCodeVerifier_Verifier(&mut verifier, &mut verifier_text);
            let verifier_string = string_of(verifier_text);

            let mut args: AuthorizationArgs = std::mem::zeroed();
            Discord_AuthorizationArgs_Init(&mut args);
            Discord_AuthorizationArgs_SetClientId(&mut args, CLIENT_ID);
            Discord_AuthorizationArgs_SetScopes(&mut args, borrow_str(&scopes_text));
            Discord_AuthorizationArgs_SetCodeChallenge(&mut args, &mut challenge);

            let flow = Box::into_raw(Box::new(Flow {
                client: client_ptr,
                verifier: verifier_string,
            }));
            sdk_note!("asking for authorization (approve the prompt)");
            Discord_Client_Authorize(
                &mut client,
                &mut args,
                on_authorized,
                None,
                flow as *mut Flow as *mut c_void,
            );

            // The pump: the SDK needs RunCallbacks every few milliseconds; the
            // queue carries the composer's sends. A generous cap keeps a
            // forgotten spike from running for the whole session.
            let deadline = Instant::now() + Duration::from_secs(900);
            loop {
                Discord_RunCallbacks();
                loop {
                    match rx.try_recv() {
                        Ok(SdkCommand::SendDm { user_id, text }) => {
                            if super::CLIENT_PTR.load(Ordering::SeqCst).is_null() {
                                sdk_note!("send ignored: client gone");
                            } else {
                                Discord_Client_SendUserMessage(
                                    client_ptr,
                                    user_id,
                                    borrow_str(&text),
                                    on_message_sent,
                                    None,
                                    ptr::null_mut(),
                                );
                            }
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => return,
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            sdk_note!("spike window closed");
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
}
