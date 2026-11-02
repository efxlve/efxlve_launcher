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
//! which requests they need. The message shapes and service list follow Maxima
//! (GPL-3.0), the reference implementation of the EA client; no Maxima binary
//! is used at runtime.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyInit};

const CHALLENGE: &str = "cacf897a20b6d612ad0c05e011df52bb";
const CHALLENGE_VERSION: &str = "10,5,30,15625";
/// The fixed key the challenge response is encrypted with.
const CHALLENGE_KEY: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

static STARTED: AtomicBool = AtomicBool::new(false);
static ACCESS_TOKEN: Mutex<Option<String>> = Mutex::new(None);

type Aes128EcbEnc = ecb::Encryptor<aes::Aes128>;
type Aes128EcbDec = ecb::Decryptor<aes::Aes128>;

/// The services the EA client advertises in `GetConfig`.
const SERVICES: &[(&str, &str)] = &[
    ("EbisuSDK", "SDK"),
    ("EbisuSDK", "PROFILE"),
    ("XMPP", "PRESENCE"),
    ("XMPP", "FRIENDS"),
    ("Commerce", "COMMERCE"),
    ("EbisuSDK", "RECENTPLAYER"),
    ("EbisuSDK", "IGO"),
    ("EbisuSDK", "MISC"),
    ("EALS", "LOGIN"),
    ("EbisuSDK", "UTILITY"),
    ("XMPP", "XMPP"),
    ("XMPP", "CHAT"),
    ("EbisuSDK", "IGO_EVENT"),
    ("EALS", "EALS_EVENTS"),
    ("EbisuSDK", "LOGIN_EVENT"),
    ("XMPP", "INVITE_EVENT"),
    ("EbisuSDK", "PROFILE_EVENT"),
    ("XMPP", "PRESENCE_EVENT"),
    ("XMPP", "FRIENDS_EVENT"),
    ("Commerce", "COMMERCE_EVENT"),
    ("XMPP", "CHAT_EVENT"),
    ("EbisuSDK", "DOWNLOAD_EVENT"),
    ("EbisuSDK", "PERMISSION"),
    ("EbisuSDK", "RESOURCES"),
    ("EbisuSDK", "BLOCKED_USERS"),
    ("EbisuSDK", "BLOCKED_USER_EVENT"),
    ("EbisuSDK", "GET_USERID"),
    ("EbisuSDK", "ONLINE_STATUS_EVENT"),
    ("EbisuSDK", "ACHIEVEMENT"),
    ("EbisuSDK", "ACHIEVEMENT_EVENT"),
    ("EbisuSDK", "BROADCAST_EVENT"),
    ("PI", "PROGRESSIVE_INSTALLATION"),
    ("PI", "PROGRESSIVE_INSTALLATION_EVENT"),
    ("EbisuSDK", "CONTENT"),
];

/// Starts the listener once for this process.
///
/// The game connects to `EALsxPort` (3216) while it runs. One listener serves
/// every launch in this process; a second call is a no-op. A port that another
/// process already owns is an error, so the caller can fall back to the EA app
/// instead of starting a game that cannot reach its client.
pub(crate) fn ensure_started(port: u16, access: &str) -> Result<(), String> {
    if let Ok(mut slot) = ACCESS_TOKEN.lock() {
        *slot = Some(access.to_string());
    }
    if STARTED.load(Ordering::SeqCst) {
        return Ok(());
    }
    start(port).map_err(|err| format!("LSX listener on {port}: {err}"))?;
    STARTED.store(true, Ordering::SeqCst);
    Ok(())
}

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
    let mut content_id = String::new();
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
                    content_id = tag_text(message, "ContentId").unwrap_or_default();
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
            } else if let Some(response) = handle_request(message, &content_id) {
                let key = encryption.expect("the handshake set the key");
                send_encrypted(&mut stream, &response, &key)?;
                eprintln!("LSX >> {response}");
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

fn send_encrypted(stream: &mut TcpStream, message: &str, key: &[u8; 16]) -> Result<(), String> {
    let mut bytes = encrypt_hex(message, key)?.into_bytes();
    bytes.push(0);
    stream.write_all(&bytes).map_err(|e| e.to_string())
}

/// The request envelope: recipient, id, inner tag name and start tag.
fn request_parts(message: &str) -> Option<(String, String, String, String)> {
    let request_tag = tag(message, "Request")?;
    let recipient = attribute(&request_tag, "recipient")?;
    let id = attribute(&request_tag, "id")?;
    let start = message.find(&request_tag)? + request_tag.len();
    let rest = &message[start..];
    let open = rest.find('<')?;
    let name_start = open + 1;
    let name_end = rest[name_start..]
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')?
        + name_start;
    let name = rest[name_start..name_end].to_string();
    let tag_end = rest[name_start..].find('>')? + name_start;
    let inner = rest[open..=tag_end].to_string();
    Some((recipient, id, name, inner))
}

fn handle_request(message: &str, content_id: &str) -> Option<String> {
    let (recipient, id, name, inner) = request_parts(message)?;
    match name.as_str() {
        "GetConfig" => {
            let mut xml = format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><GetConfigResponse>"#
            );
            for (service, facility) in SERVICES {
                xml.push_str(&format!(
                    r#"<Service Name="{service}" Facility="{facility}"/>"#
                ));
            }
            xml.push_str("</GetConfigResponse></Response></LSX>");
            Some(xml)
        }
        "GetProfile" => {
            let persona = super::ea_vault::load()
                .map(|tokens| tokens.name)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| "Player".to_string());
            let user_id = ACCESS_TOKEN
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .and_then(|token| super::ea_login::persona_id(&token))
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><GetProfileResponse Persona="{persona}" SubscriberLevel="0" CommerceCurrency="USD" IsTrialSubscriber="false" Country="US" UserId="{user_id}" GeoCountry="US" AvatarId="" IsSubscriber="false" IsSteamSubscriber="true" PersonaId="{user_id}" IsUnderAge="false" UserIndex="0"/></Response></LSX>"#
            ))
        }
        "GetSetting" => {
            let key = attribute(&inner, "SettingId").unwrap_or_default();
            let value = match key.as_str() {
                "IS_IGO_ENABLED" | "IS_IGO_AVAILABLE" => "false",
                "ENVIRONMENT" => "production",
                _ => "",
            };
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><GetSettingResponse Setting="{value}"/></Response></LSX>"#
            ))
        }
        "GetGameInfo" => {
            let key = attribute(&inner, "GameInfoId").unwrap_or_default();
            let value = match key.as_str() {
                "FREETRIAL" => "false",
                "LANGUAGES" => "ar_SA,de_DE,en_US,es_ES,es_MX,fr_FR,it_IT,ja_JP,ko_KR,pl_PL,pt_BR,ru_RU,zh_CN,zh_TW",
                "INSTALLED_LANGUAGE" => "en_US",
                _ => "",
            };
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><GetGameInfoResponse GameInfo="{value}"/></Response></LSX>"#
            ))
        }
        "GetAllGameInfo" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><GetAllGameInfoResponse FullGamePurchased="true" FullGameReleased="true" InstalledVersion="0" MaxGroupSize="16" Languages="ar_SA,de_DE,en_US,es_ES,es_MX,fr_FR,it_IT,ja_JP,ko_KR,pl_PL,pt_BR,ru_RU,zh_CN,zh_TW" Expiration="0000-00-00T00:00:00" UpToDate="true" HasExpiration="false" InstalledLanguage="en_US" EntitlementSource="STEAM" FullGameReleaseDate="2016-06-07T00:00:00" AvailableVersion="1.0.3.47248" DisplayName="Mirror's Edge Catalyst" FreeTrial="false" SystemTime="2026-11-02T00:00:00"/></Response></LSX>"#
        )),
        "GetInternetConnectedState" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><InternetConnectedState connected="1"/></Response></LSX>"#
        )),
        "GetBlockList" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><GetBlockListResponse Return="0"/></Response></LSX>"#
        )),
        "IsProgressiveInstallationAvailable" => {
            let item = attribute(&inner, "ItemId").unwrap_or_default();
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><IsProgressiveInstallationAvailableResponse ItemId="{item}" Available="false"/></Response></LSX>"#
            ))
        }
        "AreChunksInstalled" => {
            let item = attribute(&inner, "ItemId").unwrap_or_default();
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><AreChunksInstalledResponse ItemId="{item}" Installed="true"/></Response></LSX>"#
            ))
        }
        "GetPresence" => {
            let user = attribute(&inner, "UserId").unwrap_or_default();
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><GetPresenceResponse UserId="{user}" Presence="ONLINE"/></Response></LSX>"#
            ))
        }
        "QueryEntitlements" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><QueryEntitlementsResponse/></Response></LSX>"#
        )),
        "QueryOffers" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><QueryOffersResponse/></Response></LSX>"#
        )),
        "QueryFriends" | "QueryPresence" => Some(format!(
            r#"<LSX><Response sender="{recipient}" id="{id}"><{name}Response/></Response></LSX>"#
        )),
        "RequestLicense" => {
            let ticket = attribute(&inner, "RequestTicket").unwrap_or_default();
            let engine = attribute(&inner, "TicketEngine").unwrap_or_default();
            let access = ACCESS_TOKEN
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .unwrap_or_default();
            if access.is_empty() || content_id.is_empty() {
                eprintln!("LSX RequestLicense without a session");
                return None;
            }
            let hash = super::ea_machine::hardware_hash(2).ok()?;
            let token = match block_on(super::ea_license::game_token(
                &access,
                content_id,
                &hash,
                &ticket,
                &engine,
            )) {
                Some(Ok(token)) => token,
                Some(Err(err)) => {
                    eprintln!("LSX RequestLicense failed: {err}");
                    return None;
                }
                None => return None,
            };
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><RequestLicenseResponse License="{token}"/></Response></LSX>"#
            ))
        }
        "GetAuthCode" => {
            let client_id = attribute(&inner, "ClientId").unwrap_or_default();
            let access = ACCESS_TOKEN
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .unwrap_or_default();
            let code = if access.is_empty() || client_id.is_empty() {
                "invalid".to_string()
            } else {
                block_on(super::ea_login::auth_code(&access, &client_id))
                    .and_then(|result| result.ok())
                    .unwrap_or_else(|| "invalid".to_string())
            };
            Some(format!(
                r#"<LSX><Response sender="{recipient}" id="{id}"><AuthCode value="{code}"/></Response></LSX>"#
            ))
        }
        "SetPresence" | "ShowIGOWindow" | "SetDownloaderUtilization" | "GetVoipStatus" => None,
        _ => {
            eprintln!("LSX unhandled request: {name}");
            None
        }
    }
}

fn tag_text(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(xml[start..end].to_string())
}

fn block_on<F: std::future::Future>(future: F) -> Option<F::Output> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    Some(runtime.block_on(future))
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
