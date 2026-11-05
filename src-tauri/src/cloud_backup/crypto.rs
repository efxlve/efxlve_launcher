//! Optional password envelope for launcher profile archives.
//!
//! Layout: `EFXENC1` + version byte, a 16-byte scrypt salt, a 12-byte GCM
//! nonce, then the AES-256-GCM ciphertext with its tag. The header is not
//! encrypted; the magic lets the importer ask for a password only when the
//! file really is encrypted, and older plain `.tar.gz` profiles keep working.

use std::fs;
use std::io::Read;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;

const MAGIC: &[u8; 7] = b"EFXENC1";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 8 + 16 + 12;
const MAX_PLAIN_BYTES: u64 = 256 * 1024 * 1024;
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

/// True when the file starts with the encrypted-profile magic.
pub fn is_encrypted(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 8];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    magic.starts_with(MAGIC) && magic[7] <= VERSION
}

fn derive_key(password: &str, salt: &[u8; 16]) -> Result<[u8; 32], String> {
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, 32)
        .map_err(|error| format!("scrypt parameters: {error}"))?;
    let mut key = [0u8; 32];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key)
        .map_err(|error| format!("key derivation failed: {error}"))?;
    Ok(key)
}

/// Encrypts `plaintext` with a fresh salt and nonce.
pub fn encrypt_bytes(plaintext: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if password.trim().is_empty() {
        return Err("@t:profile.passwordRequired".to_string());
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);

    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("cipher setup failed: {error}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "@t:profile.encryptFailed".to_string())?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts an envelope produced by [`encrypt_bytes`].
pub fn decrypt_bytes(envelope: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if envelope.len() < HEADER_LEN || !envelope.starts_with(MAGIC) {
        return Err("@t:profile.notEncrypted".to_string());
    }
    if envelope[7] != VERSION {
        return Err("@t:profile.unsupportedEncryption".to_string());
    }
    if password.trim().is_empty() {
        return Err("@t:profile.passwordRequired".to_string());
    }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&envelope[8..24]);
    let nonce = &envelope[24..36];
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("cipher setup failed: {error}"))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), &envelope[HEADER_LEN..])
        .map_err(|_| "@t:profile.badPassword".to_string())
}

/// Encrypts one file into another. The inputs are profile archives, capped at
/// 256 MB, so the whole file fits comfortably in memory.
pub fn encrypt_file(source: &Path, target: &Path, password: &str) -> Result<(), String> {
    let size = fs::metadata(source).map_err(|error| error.to_string())?.len();
    if size > MAX_PLAIN_BYTES {
        return Err("@t:profile.tooLarge".to_string());
    }
    let plain = fs::read(source).map_err(|error| error.to_string())?;
    let envelope = encrypt_bytes(&plain, password)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target, envelope).map_err(|error| error.to_string())
}

/// Decrypts one encrypted profile into a plain tar.gz.
pub fn decrypt_file(source: &Path, target: &Path, password: &str) -> Result<(), String> {
    let size = fs::metadata(source).map_err(|error| error.to_string())?.len();
    if size > MAX_PLAIN_BYTES + HEADER_LEN as u64 + 16 {
        return Err("@t:profile.tooLarge".to_string());
    }
    let envelope = fs::read(source).map_err(|error| error.to_string())?;
    let plain = decrypt_bytes(&envelope, password)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target, plain).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_encrypted_payload_round_trips() {
        let plain = b"save data and profile json";
        let envelope = encrypt_bytes(plain, "correct horse").unwrap();
        assert!(envelope.starts_with(MAGIC));
        assert_ne!(&envelope[HEADER_LEN..], plain);
        assert_eq!(decrypt_bytes(&envelope, "correct horse").unwrap(), plain);
    }

    #[test]
    fn a_wrong_password_is_rejected_without_panicking() {
        let envelope = encrypt_bytes(b"secret", "right").unwrap();
        let error = decrypt_bytes(&envelope, "wrong").unwrap_err();
        assert_eq!(error, "@t:profile.badPassword");
    }

    #[test]
    fn every_encryption_uses_a_fresh_salt_and_nonce() {
        let first = encrypt_bytes(b"same", "pw").unwrap();
        let second = encrypt_bytes(b"same", "pw").unwrap();
        assert_ne!(first[8..24], second[8..24]);
        assert_ne!(first[24..36], second[24..36]);
        assert_ne!(first[HEADER_LEN..], second[HEADER_LEN..]);
    }

    #[test]
    fn empty_passwords_are_refused() {
        assert!(encrypt_bytes(b"x", "   ").is_err());
        let envelope = encrypt_bytes(b"x", "pw").unwrap();
        assert_eq!(
            decrypt_bytes(&envelope, "").unwrap_err(),
            "@t:profile.passwordRequired"
        );
    }

    #[test]
    fn a_plain_file_is_not_mistaken_for_an_envelope() {
        let base = std::env::temp_dir().join(format!(
            "efxlve_crypto_plain_{}_{}",
            std::process::id(),
            now_stamp()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("profile.efxprofile");
        std::fs::write(&path, b"plain tar.gz").unwrap();
        assert!(!is_encrypted(&path));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn an_encrypted_profile_archive_still_unpacks() {
        use crate::cloud_backup::archive::{pack_backup_dir, unpack_backup_tar_gz};

        let base = std::env::temp_dir().join(format!(
            "efxlve_crypto_archive_{}_{}",
            std::process::id(),
            now_stamp()
        ));
        let stage = base.join("stage");
        std::fs::create_dir_all(stage.join("files/config")).unwrap();
        std::fs::write(stage.join("profile.json"), r#"{"format":1}"#).unwrap();
        std::fs::write(
            stage.join("files/config/collections.json"),
            r#"{"collections":[]}"#,
        )
        .unwrap();
        let plain = base.join("plain.tar.gz");
        let encrypted = base.join("profile.efxprofile");
        let restored = base.join("restored.tar.gz");
        let unpacked = base.join("unpacked");

        pack_backup_dir(&stage, &plain).unwrap();
        encrypt_file(&plain, &encrypted, "hunter2").unwrap();
        assert!(is_encrypted(&encrypted));
        decrypt_file(&encrypted, &restored, "hunter2").unwrap();
        unpack_backup_tar_gz(&restored, &unpacked).unwrap();
        assert_eq!(
            std::fs::read_to_string(unpacked.join("profile.json")).unwrap(),
            r#"{"format":1}"#
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    fn now_stamp() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    }
}
