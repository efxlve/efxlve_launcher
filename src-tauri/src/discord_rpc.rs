//! Discord local-RPC voice probe (spike for the overlay's Discord tab).
//!
//! Experimental and dev-facing: connects to the running Discord desktop
//! client's IPC pipe, walks the documented steps (handshake, AUTHORIZE with
//! the `rpc` + `rpc.voice.read` scopes, PKCE token exchange, AUTHENTICATE),
//! then reads the selected voice channel and listens for speaking events.
//!
//! Because the dev terminal is noisy, the probe writes to
//! `<app_data>/logs/discord-rpc.log` (fresh per run) as well as stderr, so the
//! run can be read back without copying from the terminal. Token-ish fields
//! are masked before they are written. Trigger: F9 on the Discord page (dev
//! builds only).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The launcher's Discord application; the same id the Rich Presence worker
/// uses (`DEFAULT_DISCORD_CLIENT_ID` in `src/features/presence/presence.ts`).
const CLIENT_ID: &str = "1551663205426794596";

/// One probe per app run: a second connection would walk into Discord's
/// two-connections-per-minute IPC limit.
static PROBE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Mirror of the probe log (`<app_data>/logs/discord-rpc.log`), one run per
/// file. Opened by the command before the probe thread starts.
static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

/// Writes one probe line to the terminal and the log file.
fn plog(line: &str) {
    eprintln!("[discord-rpc] {line}");
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "[discord-rpc] {line}");
            let _ = file.flush();
        }
    }
}

/// Spawns the probe thread. Dev builds only; release is a no-op.
#[tauri::command]
pub fn discord_voice_probe(app: AppHandle) {
    #[cfg(debug_assertions)]
    {
        if PROBE_RUNNING.swap(true, Ordering::SeqCst) {
            // Repeated key presses are common; say it once, not per press.
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::SeqCst) {
                plog("probe already ran or is running; restart the app to retry");
            }
            return;
        }
        // A fresh log per run: the previous run's outcome is not mixed in.
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
        let spawned = std::thread::Builder::new()
            .name("discord-voice-probe".to_string())
            .spawn(|| {
                if let Err(error) = run_probe() {
                    plog(&format!("probe stopped: {error}"));
                }
            });
        if spawned.is_err() {
            plog("probe thread could not start");
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
}

fn run_probe() -> std::io::Result<()> {
    let Some(mut pipe) = connect() else {
        plog("no Discord IPC pipe found; is the desktop client running?");
        return Ok(());
    };

    // Handshake, then READY carries the own user object.
    write_frame(&mut pipe, 0, &json!({ "v": 1, "client_id": CLIENT_ID }))?;
    let (_, ready) = next_frame(&mut pipe)?;
    plog(&format!("READY: {}", compact(&ready)));

    // Baseline: this command needs the `rpc` scope, so before authorizing it
    // should answer with a scope error. Documents the unauthenticated state.
    send(&mut pipe, &json!({
        "cmd": "GET_SELECTED_VOICE_CHANNEL",
        "args": {},
        "nonce": nonce()
    }))?;
    let (_, pre) = next_frame(&mut pipe)?;
    plog(&format!("pre-auth GET_SELECTED_VOICE_CHANNEL: {}", compact(&pre)));

    // Discord's RPC OAuth2 authorize is picky about the argument shape and the
    // validation errors contradict each other (a redirect_uri is demanded with
    // one shape and refused with the next). Walk the documented shapes in
    // order; the first one that validates triggers the consent prompt, so at
    // most one prompt appears. The variant decides the exchange shape.
    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let scopes = json!(["rpc", "rpc.voice.read"]);
    let variants: [(&str, Value, Option<&str>); 3] = [
        (
            "bare",
            json!({ "client_id": CLIENT_ID, "scopes": scopes }),
            None,
        ),
        (
            "response_type",
            json!({
                "client_id": CLIENT_ID,
                "scopes": scopes,
                "response_type": "code"
            }),
            None,
        ),
        (
            "pkce",
            json!({
                "client_id": CLIENT_ID,
                "scopes": scopes,
                "code_challenge": challenge,
                "code_challenge_method": "S256"
            }),
            Some(verifier.as_str()),
        ),
    ];

    let mut authorized: Option<(String, Option<String>)> = None;
    for (name, args, exchange_verifier) in &variants {
        plog(&format!(
            "asking for consent [{name}] — approve the prompt in Discord if it appears"
        ));
        send(&mut pipe, &json!({ "cmd": "AUTHORIZE", "args": args, "nonce": nonce() }))?;
        let mut next_variant = false;
        loop {
            let (_, frame) = next_frame(&mut pipe)?;
            let cmd = frame.get("cmd").and_then(Value::as_str).unwrap_or("");
            plog(&format!("frame cmd={cmd}: {}", compact(&frame)));
            if cmd == "AUTHORIZE" {
                let message = frame
                    .pointer("/data/message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if message.contains("denied") || message.contains("cancel") {
                    plog("authorization was declined; stopping");
                    return Ok(());
                }
                if let Some(code) = frame.pointer("/data/code").and_then(Value::as_str) {
                    authorized = Some((
                        code.to_string(),
                        exchange_verifier.map(str::to_string),
                    ));
                    break;
                }
                // A code-less AUTHORIZE answer is a validation failure: next shape.
                next_variant = true;
                break;
            }
            if cmd == "ERROR" {
                next_variant = true;
                break;
            }
        }
        if !next_variant {
            break;
        }
    }
    let Some((code, exchange_verifier)) = authorized else {
        plog("no AUTHORIZE shape was accepted; stopping (approval or tester list)");
        return Ok(());
    };

    // Exchange the code; the variant decides whether PKCE goes along.
    let Some(access_token) = exchange_code(&code, exchange_verifier.as_deref()) else {
        plog("token exchange failed; stopping");
        return Ok(());
    };

    send(&mut pipe, &json!({
        "cmd": "AUTHENTICATE",
        "args": { "access_token": access_token },
        "nonce": nonce()
    }))?;
    let (_, auth) = next_frame(&mut pipe)?;
    plog(&format!("AUTHENTICATE: {}", compact(&auth)));

    // With `rpc` granted, the selected voice channel now answers.
    send(&mut pipe, &json!({
        "cmd": "GET_SELECTED_VOICE_CHANNEL",
        "args": {},
        "nonce": nonce()
    }))?;
    let (_, channel) = next_frame(&mut pipe)?;
    plog(&format!("selected voice channel: {}", compact(&channel)));
    let channel_id = channel
        .pointer("/data/id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if !channel_id.is_empty() {
        for event in ["SPEAKING_START", "SPEAKING_STOP"] {
            send(&mut pipe, &json!({
                "cmd": "SUBSCRIBE",
                "evt": event,
                "args": { "channel_id": channel_id },
                "nonce": nonce()
            }))?;
            let (_, ack) = next_frame(&mut pipe)?;
            plog(&format!("subscribe {event}: {}", compact(&ack)));
        }
    }

    plog("listening — talk in the voice channel to see SPEAKING events");
    loop {
        let (_, frame) = next_frame(&mut pipe)?;
        let event = frame.get("evt").and_then(Value::as_str).unwrap_or("");
        if matches!(
            event,
            "SPEAKING_START"
                | "SPEAKING_STOP"
                | "VOICE_STATE_CREATE"
                | "VOICE_STATE_UPDATE"
                | "VOICE_STATE_DELETE"
                | "VOICE_CHANNEL_SELECT"
        ) {
            plog(&format!("event {event}: {}", compact(&frame)));
        }
    }
}

/// First free `discord-ipc-*` pipe. Blocking `File` handles are enough for the
/// spike; the real worker gets its own timed reader.
fn connect() -> Option<std::fs::File> {
    for index in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{index}");
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            plog(&format!("connected to {path}"));
            return Some(file);
        }
    }
    None
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

fn send(pipe: &mut std::fs::File, payload: &Value) -> std::io::Result<()> {
    write_frame(pipe, 1, payload)
}

/// Next non-ping frame; Discord keep-alive pings are answered with a pong.
fn next_frame(pipe: &mut std::fs::File) -> std::io::Result<(u32, Value)> {
    loop {
        let mut header = [0u8; 8];
        pipe.read_exact(&mut header)?;
        let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let mut body = vec![0u8; length];
        pipe.read_exact(&mut body)?;
        let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if opcode == 3 {
            write_frame(pipe, 4, &value)?;
            continue;
        }
        return Ok((opcode, value));
    }
}

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

/// `authorization_code` grant against Discord's token endpoint. The verifier
/// rides along only for the PKCE authorize variant; the response text is logged
/// either way so a rejected shape is visible in the log.
fn exchange_code(code: &str, verifier: Option<&str>) -> Option<String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", CLIENT_ID),
        ("grant_type", "authorization_code"),
        ("code", code),
    ];
    if let Some(verifier) = verifier {
        form.push(("code_verifier", verifier));
    }
    let response = runtime.block_on(async {
        client
            .post("https://discord.com/api/v10/oauth2/token")
            .form(&form)
            .send()
            .await
    });
    match response {
        Ok(response) => {
            let status = response.status();
            let text = runtime.block_on(response.text()).unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            plog(&format!("token exchange HTTP {status}: {}", compact(&parsed)));
            if status.is_success() {
                parsed.get("access_token")?.as_str().map(str::to_string)
            } else {
                None
            }
        }
        Err(error) => {
            plog(&format!("token exchange error: {error}"));
            None
        }
    }
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
