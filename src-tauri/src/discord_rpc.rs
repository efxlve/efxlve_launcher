//! Discord local-RPC voice probe (spike for the overlay's Discord tab).
//!
//! Experimental and dev-facing: connects to the running Discord desktop
//! client's IPC pipe, walks the documented steps (handshake, AUTHORIZE with
//! the `rpc` + `rpc.voice.read` scopes, PKCE token exchange, AUTHENTICATE),
//! then reads the selected voice channel and listens for speaking events.
//!
//! Everything is logged to the terminal that runs `tauri dev`, so the
//! approval/limit story can be verified before the overlay tab is built on
//! this. Token-ish fields are masked in the log. Trigger: F9 on the Discord
//! page (dev builds only).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

/// The launcher's Discord application; the same id the Rich Presence worker
/// uses (`DEFAULT_DISCORD_CLIENT_ID` in `src/features/presence/presence.ts`).
const CLIENT_ID: &str = "1551663205426794596";

/// One probe per app run: a second connection would walk into Discord's
/// two-connections-per-minute IPC limit.
static PROBE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Spawns the probe thread. Dev builds only; release is a no-op.
#[tauri::command]
pub fn discord_voice_probe() {
    #[cfg(debug_assertions)]
    {
        if PROBE_RUNNING.swap(true, Ordering::SeqCst) {
            eprintln!("[discord-rpc] probe already ran or is running; restart the app to retry");
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("discord-voice-probe".to_string())
            .spawn(|| {
                if let Err(error) = run_probe() {
                    eprintln!("[discord-rpc] probe stopped: {error}");
                }
            });
        if spawned.is_err() {
            eprintln!("[discord-rpc] probe thread could not start");
        }
    }
}

fn run_probe() -> std::io::Result<()> {
    let Some(mut pipe) = connect() else {
        eprintln!("[discord-rpc] no Discord IPC pipe found; is the desktop client running?");
        return Ok(());
    };

    // Handshake, then READY carries the own user object.
    write_frame(&mut pipe, 0, &json!({ "v": 1, "client_id": CLIENT_ID }))?;
    let (_, ready) = next_frame(&mut pipe)?;
    eprintln!("[discord-rpc] READY: {}", compact(&ready));

    // Baseline: this command needs the `rpc` scope, so before authorizing it
    // should answer with a scope error. Documents the unauthenticated state.
    send(&mut pipe, &json!({
        "cmd": "GET_SELECTED_VOICE_CHANNEL",
        "args": {},
        "nonce": nonce()
    }))?;
    let (_, pre) = next_frame(&mut pipe)?;
    eprintln!("[discord-rpc] pre-auth GET_SELECTED_VOICE_CHANNEL: {}", compact(&pre));

    // AUTHORIZE with PKCE. The user sees Discord's consent prompt; the answer
    // arrives on this same pipe.
    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    eprintln!("[discord-rpc] asking for consent (scopes: rpc, rpc.voice.read) — approve the prompt in Discord");
    send(&mut pipe, &json!({
        "cmd": "AUTHORIZE",
        "args": {
            "client_id": CLIENT_ID,
            "scopes": ["rpc", "rpc.voice.read"],
            "code_challenge": challenge,
            "code_challenge_method": "S256"
        },
        "nonce": nonce()
    }))?;

    let code = loop {
        let (_, frame) = next_frame(&mut pipe)?;
        let cmd = frame.get("cmd").and_then(Value::as_str).unwrap_or("");
        eprintln!("[discord-rpc] frame cmd={cmd}: {}", compact(&frame));
        if cmd == "AUTHORIZE" {
            match frame.pointer("/data/code").and_then(Value::as_str) {
                Some(code) => break code.to_string(),
                None => {
                    eprintln!("[discord-rpc] AUTHORIZE returned no code; stopping");
                    return Ok(());
                }
            }
        }
        if cmd == "ERROR" {
            eprintln!("[discord-rpc] Discord refused AUTHORIZE; stopping (approval or tester list)");
            return Ok(());
        }
    };

    // Exchange the code (PKCE, no redirect URI: nothing was redirected).
    let Some(access_token) = exchange_code(&code, &verifier) else {
        eprintln!("[discord-rpc] token exchange failed; stopping");
        return Ok(());
    };

    send(&mut pipe, &json!({
        "cmd": "AUTHENTICATE",
        "args": { "access_token": access_token },
        "nonce": nonce()
    }))?;
    let (_, auth) = next_frame(&mut pipe)?;
    eprintln!("[discord-rpc] AUTHENTICATE: {}", compact(&auth));

    // With `rpc` granted, the selected voice channel now answers.
    send(&mut pipe, &json!({
        "cmd": "GET_SELECTED_VOICE_CHANNEL",
        "args": {},
        "nonce": nonce()
    }))?;
    let (_, channel) = next_frame(&mut pipe)?;
    eprintln!("[discord-rpc] selected voice channel: {}", compact(&channel));
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
            eprintln!("[discord-rpc] subscribe {event}: {}", compact(&ack));
        }
    }

    eprintln!("[discord-rpc] listening — talk in the voice channel to see SPEAKING events");
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
            eprintln!("[discord-rpc] event {event}: {}", compact(&frame));
        }
    }
}

/// First free `discord-ipc-*` pipe. Blocking `File` handles are enough for the
/// spike; the real worker gets its own timed reader.
fn connect() -> Option<std::fs::File> {
    for index in 0..10 {
        let path = format!(r"\\.\pipe\discord-ipc-{index}");
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            eprintln!("[discord-rpc] connected to {path}");
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

/// `authorization_code` + PKCE against Discord's token endpoint. Tries without
/// a redirect URI first; the response text is logged either way so a rejected
/// variant is visible in the terminal.
fn exchange_code(code: &str, verifier: &str) -> Option<String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let response = runtime.block_on(async {
        client
            .post("https://discord.com/api/v10/oauth2/token")
            .form(&[
                ("client_id", CLIENT_ID),
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", verifier),
            ])
            .send()
            .await
    });
    match response {
        Ok(response) => {
            let status = response.status();
            let text = runtime.block_on(response.text()).unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            eprintln!("[discord-rpc] token exchange HTTP {status}: {}", compact(&parsed));
            if status.is_success() {
                parsed.get("access_token")?.as_str().map(str::to_string)
            } else {
                None
            }
        }
        Err(error) => {
            eprintln!("[discord-rpc] token exchange error: {error}");
            None
        }
    }
}

/// Token-ish fields are masked before anything reaches the terminal.
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

/// One-line JSON for the terminal, masked and capped.
fn compact(value: &Value) -> String {
    let text = mask(value).to_string();
    if text.chars().count() > 400 {
        format!("{}…", text.chars().take(400).collect::<String>())
    } else {
        text
    }
}
