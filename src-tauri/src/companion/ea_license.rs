//! The activation license EA hands a game before it starts.
//!
//! Modern EA titles read a signed `.dlf` from
//! `C:\ProgramData\Electronic Arts\EA Services\License`. The license service
//! returns an AES-128-CBC encrypted XML body plus an `x-signature` header; the
//! game expects the 65-byte signature prefix followed by the encrypted XML.
//! This module asks for that license with the signed-in account token and
//! writes it next to the ones the EA app already left there. The format follows
//! Maxima (GPL-3.0).

use std::path::PathBuf;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::Engine;

const KEY: [u8; 16] = [
    65, 50, 114, 45, 208, 130, 239, 176, 220, 100, 87, 197, 118, 104, 202, 9,
];
const ENDPOINT: &str = "https://proxy.novafusion.ea.com/licenses";
const LICENSE_DIR: &str = r"C:\ProgramData\Electronic Arts\EA Services\License";
const REFRESH_AFTER: u64 = 14 * 24 * 60 * 60;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

/// A content id is a manifest value, never user input, but it becomes a file
/// name, so it still passes a character allowlist.
fn safe_content_id(content_id: &str) -> bool {
    !content_id.is_empty()
        && content_id.len() <= 64
        && content_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub(crate) fn license_path(content_id: &str) -> Result<PathBuf, String> {
    if !safe_content_id(content_id) {
        return Err("EA license: invalid content id".into());
    }
    Ok(PathBuf::from(LICENSE_DIR).join(format!("{content_id}.dlf")))
}

/// A license younger than two weeks is still accepted by the game.
pub(crate) fn is_fresh(content_id: &str) -> bool {
    let Ok(path) = license_path(content_id) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    modified
        .elapsed()
        .map(|age| age.as_secs() < REFRESH_AFTER)
        .unwrap_or(false)
}

/// Requests, decrypts and writes the license when the cached one is old.
///
/// `signature_decoded` is true for the `SignatureDecoded` activation state
/// (Battlefield 2042 and other Frostbite titles): the header is base64 and the
/// game expects the decoded bytes in the prefix.
pub(crate) async fn ensure_license(
    access: &str,
    content_id: &str,
    machine_hash: &str,
    signature_decoded: bool,
) -> Result<(), String> {
    if is_fresh(content_id) {
        return Ok(());
    }

    let nonce: String = (0..4)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect();
    let response = reqwest::Client::new()
        .get(ENDPOINT)
        .query(&[
            ("contentId", content_id),
            ("machineHash", machine_hash),
            ("nonce", &nonce),
            ("ea_eadmtoken", access),
        ])
        .header("X-Requester-Id", "Origin Online Activation")
        .header("User-Agent", "EACTransaction")
        .send()
        .await
        .map_err(|e| format!("EA license: {e}"))?;

    if response.status() != reqwest::StatusCode::OK {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("EA license: HTTP {status}: {body}"));
    }

    let signature = response
        .headers()
        .get("x-signature")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "EA license: missing x-signature".to_string())?
        .to_string();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("EA license: {e}"))?
        .to_vec();
    let plain = decrypt(&body)?;

    let mut signature = if signature_decoded {
        base64::engine::general_purpose::STANDARD
            .decode(signature)
            .map_err(|_| "EA license: bad signature".to_string())?
    } else {
        signature.into_bytes()
    };
    if signature.len() > 65 {
        return Err("EA license: signature is longer than 65 bytes".into());
    }
    signature.resize(65, 0);

    let encrypted = encrypt(&plain);
    let mut blob = signature;
    blob.extend_from_slice(&encrypted);

    let path = license_path(content_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("EA license: {e}"))?;
    }
    std::fs::write(&path, &blob).map_err(|e| format!("EA license: {e}"))?;
    let cached = path.with_file_name(format!("{content_id}_cached.dlf"));
    let _ = std::fs::write(cached, &blob);
    Ok(())
}

fn decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes128CbcDec::new_from_slices(&KEY, &[0u8; 16])
        .map_err(|_| "EA license: bad decrypt key".to_string())?;
    let mut buffer = data.to_vec();
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| "EA license: decrypt failed".to_string())?;
    Ok(plain.to_vec())
}

/// Requests the Denuvo `GameToken` the LSX `RequestLicense` handler returns.
///
/// The game supplies a request ticket and a ticket engine; the license service
/// answers with the XML license that carries the token. This is separate from
/// the `.dlf`: the token is what the game's Denuvo layer waits for.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn game_token(
    access: &str,
    content_id: &str,
    machine_hash: &str,
    request_ticket: &str,
    ticket_engine: &str,
) -> Result<String, String> {
    let nonce: String = (0..4)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect();
    let response = reqwest::Client::new()
        .get(ENDPOINT)
        .query(&[
            ("contentId", content_id),
            ("machineHash", machine_hash),
            ("nonce", &nonce),
            ("ea_eadmtoken", access),
            ("requestToken", request_ticket),
            ("requestType", ticket_engine),
        ])
        .header("X-Requester-Id", "Origin Online Activation")
        .header("User-Agent", "EACTransaction")
        .send()
        .await
        .map_err(|e| format!("EA license: {e}"))?;

    if response.status() != reqwest::StatusCode::OK {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("EA license: HTTP {status}: {body}"));
    }

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("EA license: {e}"))?
        .to_vec();
    let plain = decrypt(&body)?;
    let xml = String::from_utf8(plain).map_err(|_| "EA license: not UTF-8".to_string())?;
    tag_text(&xml, "GameToken").ok_or_else(|| "EA license: no GameToken".to_string())
}

fn tag_text(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(xml[start..end].to_string())
}

fn encrypt(data: &[u8]) -> Vec<u8> {
    let cipher = Aes128CbcEnc::new_from_slices(&KEY, &[0u8; 16])
        .expect("the fixed key and iv are 16 bytes");
    let mut buffer = vec![0u8; data.len() + 16];
    buffer[..data.len()].copy_from_slice(data);
    let encrypted = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, data.len())
        .expect("the buffer has one spare block");
    encrypted.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_license_body_round_trips() {
        let plain = b"<?xml version=\"1.0\"?><License><ContentId>193874</ContentId></License>";
        let encrypted = encrypt(plain);
        assert_ne!(encrypted.as_slice(), plain.as_slice());
        assert_eq!(decrypt(&encrypted).expect("decrypt"), plain);
    }

    #[test]
    fn content_ids_cannot_escape_the_license_folder() {
        assert!(safe_content_id("193874"));
        assert!(safe_content_id("Origin.OFR.50.0002148"));
        assert!(!safe_content_id(r"..\..\Windows\System32"));
        assert!(!safe_content_id(""));
    }
}
