//! Discord voice worker: reads the local Discord client's voice channel and
//! streams it to the overlay as `discord-voice-state` events.
//!
//! One IPC connection at a time, alive only while the overlay has asked for
//! `discord_voice_watch_start` (its Discord tab is open); `.._stop` ends the
//! loop within a read tick. The first run opens Discord's consent prompt and
//! stores the tokens DPAPI-sealed in `<app_data>/discord/token.bin`; later runs
//! refresh them silently. Discord limits new IPC connections to two a minute,
//! so reconnects wait `RECONNECT_WAIT`.
//!
//! The OAuth2 authorize shape is picky (proven by the spike in the git
//! history): PKCE must ride together with `response_type: "code"`. The bare
//! shape stays as a fallback (it grants a code, but the token endpoint then
//! refuses the exchange without PKCE).
//!
//! Reads are polled through `PeekNamedPipe` so a stop request ends the worker
//! promptly instead of waiting for the next Discord frame.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// The launcher's Discord application; the same id the Rich Presence worker
/// uses (`DEFAULT_DISCORD_CLIENT_ID` in `src/features/presence/presence.ts`).
const CLIENT_ID: &str = "1551663205426794596";
/// Scopes the voice read needs: the RPC surface itself plus voice reading.
const SCOPES: [&str; 2] = ["rpc", "rpc.voice.read"];
/// How often the worker checks the pipe and the stop flag.
const READ_TICK: Duration = Duration::from_millis(150);
/// Minimum wait between connection attempts (two connections a minute limit).
const RECONNECT_WAIT: Duration = Duration::from_secs(30);
/// How long the consent prompt may stay unanswered.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// The overlay wants the voice state (its Discord tab is visible).
static WATCH_WANTED: AtomicBool = AtomicBool::new(false);
/// One worker thread at a time.
static WORKER_RUNNING: AtomicBool = AtomicBool::new(false);
/// Debug mirror of the worker log (`<app_data>/logs/discord-rpc.log`).
static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

/// One voice participant as the overlay renders it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipant {
    id: String,
    name: String,
    avatar_url: String,
    speaking: bool,
    muted: bool,
}

/// The channel the local Discord client is in.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChannelInfo {
    id: String,
    name: String,
    guild_id: Option<String>,
}

/// Payload of the `discord-voice-state` event.
/// Status: "connecting" | "authorizing" | "ready" | "error" | "idle".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordVoiceState {
    status: String,
    channel: Option<VoiceChannelInfo>,
    participants: Vec<VoiceParticipant>,
    error: Option<String>,
}

/// Starts the voice worker (idempotent). The overlay calls this while its
/// Discord tab is visible.
#[tauri::command]
pub fn discord_voice_watch_start(app: AppHandle) {
    #[cfg(windows)]
    {
        WATCH_WANTED.store(true, Ordering::SeqCst);
        if WORKER_RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        open_log(&app);
        let worker_app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("discord-voice".to_string())
            .spawn(move || {
                worker(&worker_app);
                WORKER_RUNNING.store(false, Ordering::SeqCst);
            });
        if spawned.is_err() {
            WORKER_RUNNING.store(false, Ordering::SeqCst);
            plog("voice worker could not start");
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Asks the worker to stop; it notices within one read tick and disconnects.
#[tauri::command]
pub fn discord_voice_watch_stop() {
    WATCH_WANTED.store(false, Ordering::SeqCst);
}

/// Writes one worker line to the terminal and the log file.
fn plog(line: &str) {
    eprintln!("[discord-rpc] {line}");
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "[discord-rpc] {line}");
            let _ = file.flush();
        }
    }
}

/// A fresh log per watch start; the previous run's outcome stays readable.
fn open_log(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join("logs").join("discord-rpc.log");
        let _ = std::fs::create_dir_all(dir.join("logs"));
        if let Ok(file) = std::fs::File::create(&path) {
            plog(&format!("log file: {}", path.display()));
            if let Ok(mut guard) = LOG_FILE.lock() {
                *guard = Some(file);
            }
        }
    }
}

/// The worker loop: connect, stream, and reconnect with a cooldown.
#[cfg(windows)]
fn worker(app: &AppHandle) {
    plog("worker started");
    while WATCH_WANTED.load(Ordering::SeqCst) {
        emit_voice(app, "connecting", None, Vec::new(), None);
        if let Err(error) = session(app) {
            plog(&format!("session ended: {error}"));
            emit_voice(app, "error", None, Vec::new(), Some(error));
        }
        if !WATCH_WANTED.load(Ordering::SeqCst) {
            break;
        }
        plog(&format!("reconnecting in {}s", RECONNECT_WAIT.as_secs()));
        let deadline = Instant::now() + RECONNECT_WAIT;
        while Instant::now() < deadline && WATCH_WANTED.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    plog("worker stopped");
    emit_voice(app, "idle", None, Vec::new(), None);
}

/// One connection's lifetime: handshake, auth, then stream until the watch
/// ends or the pipe drops.
#[cfg(windows)]
fn session(app: &AppHandle) -> Result<(), String> {
    let mut conn = Pipe::connect()?;
    conn.wait_for(
        &|frame| frame.get("evt").and_then(Value::as_str) == Some("READY"),
        Duration::from_secs(10),
    )?;
    let access = access_token(app, &mut conn)?;
    conn.send(&json!({
        "cmd": "AUTHENTICATE",
        "args": { "access_token": access },
        "nonce": nonce()
    }))?;
    let answer = conn.wait_for(
        &|frame| frame.get("cmd").and_then(Value::as_str) == Some("AUTHENTICATE"),
        Duration::from_secs(15),
    )?;
    if answer.get("evt").and_then(Value::as_str) == Some("ERROR") {
        return Err(format!(
            "Authenticate failed: {}",
            answer
                .pointer("/data/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    plog("authenticated");

    // Tells the worker whenever the user moves between voice channels.
    conn.send(&json!({ "cmd": "SUBSCRIBE", "evt": "VOICE_CHANNEL_SELECT", "nonce": nonce() }))?;

    let mut speaking: HashSet<String> = HashSet::new();
    let mut subscribed_channel = String::new();
    let mut channel: Option<VoiceChannelInfo> = None;
    let mut participants: Vec<VoiceParticipant> = Vec::new();
    refresh_voice(
        app,
        &mut conn,
        &mut subscribed_channel,
        &mut channel,
        &mut participants,
        &mut speaking,
    )?;

    loop {
        if !WATCH_WANTED.load(Ordering::SeqCst) {
            return Ok(());
        }
        for frame in conn.read_now()? {
            let event = frame.get("evt").and_then(Value::as_str).unwrap_or("");
            match event {
                "SPEAKING_START" | "SPEAKING_STOP" => {
                    if let Some(user_id) = frame.pointer("/data/user_id").and_then(Value::as_str) {
                        if event == "SPEAKING_START" {
                            speaking.insert(user_id.to_string());
                        } else {
                            speaking.remove(user_id);
                        }
                        emit_participants(app, &channel, &participants, &speaking);
                    }
                }
                // Any voice-structure change simply re-reads the channel; the
                // payloads differ between clients and a local read is cheap.
                "VOICE_CHANNEL_SELECT"
                | "VOICE_STATE_CREATE"
                | "VOICE_STATE_DELETE"
                | "VOICE_STATE_UPDATE" => {
                    refresh_voice(
                        app,
                        &mut conn,
                        &mut subscribed_channel,
                        &mut channel,
                        &mut participants,
                        &mut speaking,
                    )?;
                }
                _ => {}
            }
        }
        std::thread::sleep(READ_TICK);
    }
}

/// Re-reads the selected voice channel, keeps subscriptions in step and emits
/// the fresh state.
#[cfg(windows)]
fn refresh_voice(
    app: &AppHandle,
    conn: &mut Pipe,
    subscribed_channel: &mut String,
    channel: &mut Option<VoiceChannelInfo>,
    participants: &mut Vec<VoiceParticipant>,
    speaking: &mut HashSet<String>,
) -> Result<(), String> {
    conn.send(&json!({
        "cmd": "GET_SELECTED_VOICE_CHANNEL",
        "args": {},
        "nonce": nonce()
    }))?;
    let response = conn.wait_for(
        &|frame| frame.get("cmd").and_then(Value::as_str) == Some("GET_SELECTED_VOICE_CHANNEL"),
        Duration::from_secs(15),
    )?;

    match voice_channel_from(&response) {
        Some((info, mut people)) => {
            speaking.retain(|id| people.iter().any(|person| &person.id == id));
            for person in &mut people {
                person.speaking = speaking.contains(&person.id);
            }
            *channel = Some(info);
            *participants = people;
        }
        None => {
            channel.take();
            participants.clear();
            speaking.clear();
        }
    }

    if let Some(info) = channel.as_ref() {
        if info.id != *subscribed_channel {
            *subscribed_channel = info.id.clone();
            for event in [
                "SPEAKING_START",
                "SPEAKING_STOP",
                "VOICE_STATE_CREATE",
                "VOICE_STATE_DELETE",
                "VOICE_STATE_UPDATE",
            ] {
                conn.send(&json!({
                    "cmd": "SUBSCRIBE",
                    "evt": event,
                    "args": { "channel_id": info.id },
                    "nonce": nonce()
                }))?;
            }
        }
    }

    emit_participants(app, channel, participants, speaking);
    Ok(())
}

/// Parses `GET_SELECTED_VOICE_CHANNEL` data into the channel and its members.
/// `None` means the client is not in a voice channel (data is null).
fn voice_channel_from(response: &Value) -> Option<(VoiceChannelInfo, Vec<VoiceParticipant>)> {
    let data = response.get("data")?;
    if data.is_null() {
        return None;
    }
    let id = data.get("id")?.as_str()?.to_string();
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let guild_id = data
        .get("guild_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let participants = data
        .get("voice_states")
        .and_then(Value::as_array)
        .map(|states| {
            states
                .iter()
                .filter_map(|state| {
                    let user = state.get("user")?;
                    let user_id = user.get("id")?.as_str()?.to_string();
                    let name = user
                        .get("global_name")
                        .and_then(Value::as_str)
                        .or_else(|| user.get("username").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string();
                    let avatar = user.get("avatar").and_then(Value::as_str).unwrap_or("");
                    let inner = state.get("voice_state");
                    let muted = inner
                        .and_then(|value| value.get("self_mute"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        || inner
                            .and_then(|value| value.get("mute"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        || state.get("mute").and_then(Value::as_bool).unwrap_or(false);
                    Some(VoiceParticipant {
                        avatar_url: avatar_url(&user_id, avatar),
                        id: user_id,
                        name,
                        speaking: false,
                        muted,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some((
        VoiceChannelInfo {
            id,
            name,
            guild_id,
        },
        participants,
    ))
}

/// Discord CDN avatar for a user; the default embed avatar covers hash-less
/// accounts.
fn avatar_url(user_id: &str, avatar_hash: &str) -> String {
    if avatar_hash.is_empty() {
        let index = user_id
            .parse::<u64>()
            .map(|id| (id >> 22) % 6)
            .unwrap_or(0);
        format!("https://cdn.discordapp.com/embed/avatars/{index}.png")
    } else {
        format!("https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.png?size=64")
    }
}

fn emit_voice(
    app: &AppHandle,
    status: &str,
    channel: Option<VoiceChannelInfo>,
    participants: Vec<VoiceParticipant>,
    error: Option<String>,
) {
    let _ = app.emit(
        "discord-voice-state",
        DiscordVoiceState {
            status: status.to_string(),
            channel,
            participants,
            error,
        },
    );
}

/// Emits the current state with the live speaking flags folded in.
fn emit_participants(
    app: &AppHandle,
    channel: &Option<VoiceChannelInfo>,
    participants: &[VoiceParticipant],
    speaking: &HashSet<String>,
) {
    let people: Vec<VoiceParticipant> = participants
        .iter()
        .map(|person| VoiceParticipant {
            speaking: speaking.contains(&person.id),
            ..person.clone()
        })
        .collect();
    emit_voice(app, "ready", channel.clone(), people, None);
}

/* ---------- tokens ---------- */

#[derive(Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    /// Unix seconds; refreshed early so an expired token never leaves the app.
    expires_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn token_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("discord").join("token.bin"))
}

fn load_token(app: &AppHandle) -> Option<StoredToken> {
    let path = token_path(app)?;
    let sealed = std::fs::read(path).ok()?;
    let plain = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn save_token(app: &AppHandle, token: &StoredToken) {
    let Some(path) = token_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(plain) = serde_json::to_vec(token) {
        if let Ok(sealed) = crate::steam_auth::vault::dpapi::protect(&plain) {
            let _ = std::fs::write(path, sealed);
        }
    }
}

fn clear_token(app: &AppHandle) {
    if let Some(path) = token_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Stored token when fresh, a refresh when possible, and the consent prompt
/// when neither works.
fn access_token(app: &AppHandle, conn: &mut Pipe) -> Result<String, String> {
    if let Some(stored) = load_token(app) {
        if stored.expires_at > now_secs() + 60 {
            plog("using the stored token");
            return Ok(stored.access_token);
        }
        plog("refreshing the stored token");
        match refresh_stored(&stored.refresh_token) {
            Ok(fresh) => {
                save_token(app, &fresh);
                return Ok(fresh.access_token);
            }
            Err(error) => {
                plog(&format!("refresh failed: {error}; asking again"));
                clear_token(app);
            }
        }
    }
    let fresh = authorize(app, conn)?;
    save_token(app, &fresh);
    Ok(fresh.access_token)
}

/// The AUTHORIZE walk: PKCE + response_type first (the shape that exchanges),
/// bare as the fallback. At most one consent prompt appears.
fn authorize(app: &AppHandle, conn: &mut Pipe) -> Result<StoredToken, String> {
    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let scopes = json!(SCOPES);
    let variants: [(&str, Value, Option<String>); 2] = [
        (
            "pkce+response_type",
            json!({
                "client_id": CLIENT_ID,
                "scopes": scopes,
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256"
            }),
            Some(verifier),
        ),
        (
            "bare",
            json!({ "client_id": CLIENT_ID, "scopes": scopes }),
            None,
        ),
    ];

    for (name, args, exchange_verifier) in variants {
        plog(&format!(
            "asking for consent [{name}] — approve the prompt in Discord"
        ));
        emit_voice(app, "authorizing", None, Vec::new(), None);
        conn.send(&json!({ "cmd": "AUTHORIZE", "args": args, "nonce": nonce() }))?;
        let response = conn.wait_for(
            &|frame| frame.get("cmd").and_then(Value::as_str) == Some("AUTHORIZE"),
            CONSENT_TIMEOUT,
        )?;
        let message = response
            .pointer("/data/message")
            .and_then(Value::as_str)
            .unwrap_or("");
        let lowered = message.to_ascii_lowercase();
        if lowered.contains("denied") || lowered.contains("cancel") {
            return Err("Discord authorization was declined".into());
        }
        if let Some(code) = response.pointer("/data/code").and_then(Value::as_str) {
            return exchange_code(code, exchange_verifier.as_deref());
        }
        plog(&format!("authorize shape [{name}] rejected: {message}"));
    }
    Err("Discord did not accept any authorize shape".into())
}

fn exchange_code(code: &str, verifier: Option<&str>) -> Result<StoredToken, String> {
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", CLIENT_ID),
        ("grant_type", "authorization_code"),
        ("code", code),
    ];
    if let Some(verifier) = verifier {
        form.push(("code_verifier", verifier));
    }
    post_token(&form)
}

fn refresh_stored(refresh: &str) -> Result<StoredToken, String> {
    post_token(&[
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
    ])
}

/// OAuth2 token endpoint round trip; the response is logged (masked) so a
/// rejected shape is visible in the log.
fn post_token(form: &[(&str, &str)]) -> Result<StoredToken, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = runtime
        .block_on(async {
            client
                .post("https://discord.com/api/v10/oauth2/token")
                .form(form)
                .send()
                .await
        })
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let text = runtime.block_on(response.text()).unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    plog(&format!("token endpoint HTTP {status}: {}", compact(&parsed)));
    if !status.is_success() {
        return Err(format!("token endpoint HTTP {status}"));
    }
    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("token response had no access_token")?
        .to_string();
    let refresh_token = parsed
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expires_in = parsed
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    Ok(StoredToken {
        access_token,
        refresh_token,
        expires_at: now_secs() + expires_in.saturating_sub(60),
    })
}

/* ---------- pipe ---------- */

/// One Discord IPC connection with polled reads.
struct Pipe {
    file: std::fs::File,
    pending: Vec<u8>,
}

/// First free `discord-ipc-*` pipe, handshaken.
#[cfg(windows)]
impl Pipe {
    fn connect() -> Result<Pipe, String> {
        for index in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{index}");
            if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                plog(&format!("connected to {path}"));
                let mut pipe = Pipe {
                    file,
                    pending: Vec::new(),
                };
                write_frame(&mut pipe.file, 0, &json!({ "v": 1, "client_id": CLIENT_ID }))
                    .map_err(|error| error.to_string())?;
                return Ok(pipe);
            }
        }
        Err("Discord is not running (no IPC pipe found)".into())
    }

    fn send(&mut self, payload: &Value) -> Result<(), String> {
        write_frame(&mut self.file, 1, payload).map_err(|error| error.to_string())
    }

    /// Drains every complete frame currently readable; keep-alive pings are
    /// answered with a pong and dropped.
    fn read_now(&mut self) -> Result<Vec<Value>, String> {
        let available = peek_available(&self.file).map_err(|error| error.to_string())?;
        if available > 0 {
            let mut buffer = vec![0u8; available as usize];
            let read = self
                .file
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            self.pending.extend_from_slice(&buffer[..read]);
        }

        let mut frames = Vec::new();
        loop {
            if self.pending.len() < 8 {
                break;
            }
            let opcode = u32::from_le_bytes([
                self.pending[0],
                self.pending[1],
                self.pending[2],
                self.pending[3],
            ]);
            let length = u32::from_le_bytes([
                self.pending[4],
                self.pending[5],
                self.pending[6],
                self.pending[7],
            ]) as usize;
            if self.pending.len() < 8 + length {
                break;
            }
            let body: Vec<u8> = self.pending.drain(..8 + length).skip(8).collect();
            let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if opcode == 3 {
                let _ = write_frame(&mut self.file, 4, &value);
                continue;
            }
            frames.push(value);
        }
        Ok(frames)
    }

    /// Polls frames until `wanted` matches or the timeout/watch ends.
    fn wait_for(
        &mut self,
        wanted: &dyn Fn(&Value) -> bool,
        timeout: Duration,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            for frame in self.read_now()? {
                if wanted(&frame) {
                    return Ok(frame);
                }
            }
            if Instant::now() >= deadline {
                return Err("timed out waiting for Discord".into());
            }
            if !WATCH_WANTED.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            std::thread::sleep(READ_TICK);
        }
    }
}

/// Bytes waiting on the pipe; a timed peek instead of a blocking read so the
/// stop flag is honoured within a tick.
#[cfg(windows)]
fn peek_available(pipe: &std::fs::File) -> std::io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::PeekNamedPipe;
    let mut available = 0u32;
    unsafe {
        PeekNamedPipe(
            HANDLE(pipe.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut available),
            None,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(available)
}

/// IPC frame: 4-byte little-endian opcode, 4-byte length, JSON payload.
fn write_frame(pipe: &mut std::fs::File, opcode: u32, payload: &Value) -> std::io::Result<()> {
    let text = payload.to_string();
    let mut frame = Vec::with_capacity(8 + text.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(text.len() as u32).to_le_bytes());
    frame.extend_from_slice(text.as_bytes());
    pipe.write_all(&frame)?;
    pipe.flush()
}

/* ---------- helpers ---------- */

fn nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn pkce_verifier() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url(&bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    base64_url(&Sha256::digest(verifier.as_bytes()))
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Token-ish fields are masked before they are written anywhere.
fn mask(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, inner)| {
                    let lowered = key.to_ascii_lowercase();
                    let masked = if lowered.contains("token") || lowered.contains("secret") {
                        Value::String("…".to_string())
                    } else {
                        mask(inner)
                    };
                    (key.clone(), masked)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(mask).collect()),
        other => other.clone(),
    }
}

/// One-line JSON for the log, masked and capped.
fn compact(value: &Value) -> String {
    let text = mask(value).to_string();
    if text.chars().count() > 400 {
        format!("{}…", text.chars().take(400).collect::<String>())
    } else {
        text
    }
}
