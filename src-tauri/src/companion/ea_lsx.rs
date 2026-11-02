//! A minimal EA LSX server.
//!
//! EA games do not stop at the license file: while they run they open a TCP
//! connection to `EALsxPort` and speak a small XML protocol with the EA client.
//! The client answers the challenge, derives an AES key and then serves
//! entitlements, auth codes and — for Denuvo titles — the `RequestLicense`
//! ticket. Without this server the game falls back to starting the EA app.
//!
//! This module is the beginning of our own implementation: the handshake and a
//! transparent request log. Handlers are added one by one as the games reveal
//! which requests they need.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyInit};

const CHALLENGE: &str = "cacf897a20b6d612ad0c05e011df52bb";
const CHALLENGE_VERSION: &str = "10,5,30,15625";
/// The fixed key the challenge response is encrypted with.
const CHALLENGE_KEY: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

type Aes128EcbEnc = ecb::Encryptor<aes::Aes128>;
type Aes128EcbDec = ecb::Decryptor<aes::Aes128>;

/// Starts the listener on `127.0.0.1:<port>` and returns its thread.
pub(crate) fn start(port: u16) -> std::io::Result<std::thread::JoinHandle<()>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    eprintln!("LSX listening on 127.0.0.1:{port}");
    Ok(std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    eprintln!("LSX connect: {:?}", stream.peer_addr());
                    std::thread::spawn(move || {
                        if let Err(err) = serve(stream) {
                            eprintln!("LSX: {err}");
                        }
                    });
                }
                Err(err) => eprintln!("LSX accept: {err}"),
            }
        }
    }))
}

fn serve(mut stream: TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|e| e.to_string())?;
    stream
        .set_nodelay(true)
        .map_err(|e| e.to_string())?;

    send_plain(
        &mut stream,
        &format!(
            r#"<LSX><Event sender="EALS"><Challenge build="release" key="{CHALLENGE}" version="{CHALLENGE_VERSION}"/></Event></LSX>"#
        ),
    )?;

    let mut encryption: Option<[u8; 16]> = None;
    let mut buffer = [0u8; 16 * 1024];

    loop {
        let read = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        let raw = String::from_utf8_lossy(&buffer[..read]).to_string();
        let text = if let Some(key) = encryption {
            match decrypt_hex(&raw, &key) {
                Ok(text) => text,
                Err(err) => {
                    eprintln!("LSX decrypt: {err} (raw {} bytes)", raw.len());
                    continue;
                }
            }
        } else {
            raw
        };

        for message in text.split('\0').map(str::trim).filter(|m| !m.is_empty()) {
            eprintln!("LSX << {message}");

            if encryption.is_none() {
                if let Some(tag) = tag(message, "ChallengeResponse") {
                    let response = attribute(&tag, "response").unwrap_or_default();
                    let key = attribute(&tag, "key").unwrap_or_default();
                    let version = attribute(&tag, "version").unwrap_or_default();
                    let id = attribute(message, "id").unwrap_or_else(|| "1".into());

                    let plain = decrypt_hex(&response, &CHALLENGE_KEY)?;
                    if plain != CHALLENGE {
                        return Err("challenge response did not match".into());
                    }
                    let accept = encrypt_hex(&key, &CHALLENGE_KEY)?;
                    let seed = match version.as_str() {
                        "2" => 0,
                        "3" => ((accept.as_bytes()[0] as u16) << 8) | accept.as_bytes()[1] as u16,
                        other => return Err(format!("unknown LSX encryption version {other}")),
                    };
                    let key = make_lsx_key(seed);
                    encryption = Some(key);
                    send_plain(
                        &mut stream,
                        &format!(
                            r#"<LSX><Response sender="EALS" id="{id}"><ChallengeAccepted response="{accept}"/></Response></LSX>"#
                        ),
                    )?;
                    eprintln!(
                        "LSX handshake: version={version} key={}",
                        key.iter().map(|b| format!("{b:02x}")).collect::<String>()
                    );
                }
            }
        }
    }

    Ok(())
}

fn send_plain(stream: &mut TcpStream, message: &str) -> Result<(), String> {
    let mut bytes = message.as_bytes().to_vec();
    bytes.push(0);
    stream.write_all(&bytes).map_err(|e| e.to_string())
}

/// The complete `<name ...>` start tag, including attributes.
fn tag<'a>(xml: &'a str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let start = xml.find(&open)?;
    let end = xml[start..].find('>')? + start;
    Some(xml[start..=end].to_string())
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn decrypt_hex(text: &str, key: &[u8; 16]) -> Result<String, String> {
    let bytes = decode_hex(text)?;
    let cipher = Aes128EcbDec::new_from_slice(key).map_err(|_| "bad AES key".to_string())?;
    let mut buffer = bytes;
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| "bad AES block".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|_| "LSX text is not UTF-8".to_string())
}

fn encrypt_hex(text: &str, key: &[u8; 16]) -> Result<String, String> {
    let cipher = Aes128EcbEnc::new_from_slice(key).map_err(|_| "bad AES key".to_string())?;
    let data = text.as_bytes();
    let mut buffer = vec![0u8; data.len() + 16];
    buffer[..data.len()].copy_from_slice(data);
    let encrypted = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, data.len())
        .map_err(|_| "AES buffer too small".to_string())?;
    Ok(encrypted
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let clean: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    let bytes = clean.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let text = std::str::from_utf8(pair).map_err(|_| "bad hex".to_string())?;
        out.push(u8::from_str_radix(text, 16).map_err(|_| "bad hex".to_string())?);
    }
    Ok(out)
}

/// EA's small C `rand` sequence, used to derive the LSX AES key from a seed.
struct CRandom {
    seed: u32,
}

impl CRandom {
    fn new(seed: u32) -> Self {
        Self { seed }
    }

    fn next(&mut self) -> i32 {
        self.seed = self.seed.wrapping_mul(214_013).wrapping_add(2_531_011);
        ((self.seed >> 16) & 0xFFFF) as i32
    }
}

fn make_lsx_key(seed: u16) -> [u8; 16] {
    if seed == 0 {
        return CHALLENGE_KEY;
    }
    let mut crand = CRandom::new(7);
    let seed = (crand.next() as u32) + (seed as u32);
    let mut crand = CRandom::new(seed);
    let mut key = [0u8; 16];
    for byte in &mut key {
        *byte = crand.next() as u8;
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_key_round_trips() {
        let encrypted = encrypt_hex(CHALLENGE, &CHALLENGE_KEY).expect("encrypt");
        assert_ne!(encrypted, CHALLENGE);
        assert_eq!(decrypt_hex(&encrypted, &CHALLENGE_KEY).expect("decrypt"), CHALLENGE);
    }

    #[test]
    fn attributes_are_read_from_the_start_tag() {
        let xml = r#"<LSX><Request recipient="EALS" id="7"><ChallengeResponse response="aa" key="bb" version="3"/></Request></LSX>"#;
        let tag = tag(xml, "ChallengeResponse").expect("tag");
        assert_eq!(attribute(&tag, "response").as_deref(), Some("aa"));
        assert_eq!(attribute(&tag, "key").as_deref(), Some("bb"));
        assert_eq!(attribute(xml, "id").as_deref(), Some("7"));
    }

    #[test]
    fn the_c_random_sequence_is_stable() {
        let mut random = CRandom::new(7);
        let first = random.next();
        let second = random.next();
        assert_eq!(first, 61);
        assert_eq!(second, 50_190);
    }
}
