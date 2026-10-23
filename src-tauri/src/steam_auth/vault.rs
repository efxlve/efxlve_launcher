//! Sealed Steam sessions on disk.
//!
//! The refresh token is wrapped with Windows DPAPI. A copied file is useless
//! on another Windows user or machine. Access tokens are not written here.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroize;

use super::*;

/* ---------- DPAPI sealed storage ---------- */

/// Refresh token as written to disk (never plain text).
#[derive(Serialize, Deserialize)]
pub struct StoredSession {
    pub(super) account_name: String,
    pub(super) steam_id: String,
    pub(super) refresh_token: String,
    pub(super) saved_at: u64,
}

#[cfg(windows)]
pub mod dpapi {
    //! Minimal `CryptProtectData` / `CryptUnprotectData` wrapper. The key is
    //! derived from the Windows user account, so a copied file is useless on
    //! another machine or user.

    use std::ffi::c_void;

    /// Win32 `DATA_BLOB`.
    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// Copies the output blob and frees the buffer Win32 allocated.
    unsafe fn take_blob(blob: DataBlob) -> Vec<u8> {
        let out = if blob.pb_data.is_null() || blob.cb_data == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(blob.pb_data, blob.cb_data as usize).to_vec()
        };
        if !blob.pb_data.is_null() {
            LocalFree(blob.pb_data as *mut c_void);
        }
        out
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: plain.len() as u32,
            pb_data: plain.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("@t:steam.err.secureStore".to_string());
        }
        Ok(unsafe { take_blob(output) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            cb_data: sealed.len() as u32,
            pb_data: sealed.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("@t:steam.err.secureStore".to_string());
        }
        Ok(unsafe { take_blob(output) })
    }
}

/// Fallback for non-Windows builds: there is no DPAPI, so the bytes pass
/// through and the file mode is the guard. Moving the token into the OS
/// keychain (Secret Service / Keychain) is tracked in TODO.md.
#[cfg(not(windows))]
pub mod dpapi {
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
}

/// Writes a vault file only the current user may read. Windows relies on DPAPI
/// for the bytes; Unix relies on the `0600` mode set at creation.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

pub fn auth_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// One saved Steam account in the vault (sealed file per SteamID64).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamSavedAccount {
    pub steam_id: String,
    pub account_name: String,
    pub last_used: u64,
    pub is_active: bool,
}

/// Paths and meta I/O are path-based so they stay unit-testable.
pub fn vault_path(dir: &Path, steam_id: &str) -> PathBuf {
    dir.join("accounts").join(format!("{steam_id}.bin"))
}

/// Ids coming back from the frontend address files inside the vault, so they
/// must be plain SteamID64 digits: anything else (`..\..\x`, names, empty)
/// could climb out of the accounts directory. `steam.rs` applies the same rule
/// to app ids before they reach a URL.
pub fn valid_steam_id(steam_id: &str) -> bool {
    !steam_id.is_empty() && steam_id.len() <= 20 && steam_id.chars().all(|c| c.is_ascii_digit())
}

pub fn meta_path(dir: &Path) -> PathBuf {
    dir.join("accounts_meta.json")
}

pub fn load_meta(dir: &Path) -> Vec<SteamSavedAccount> {
    std::fs::read_to_string(meta_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_meta(dir: &Path, accounts: &[SteamSavedAccount]) {
    let _ = std::fs::create_dir_all(dir.join("accounts"));
    if let Ok(text) = serde_json::to_string(accounts) {
        let _ = write_private(&meta_path(dir), text.as_bytes());
    }
}

/// SteamID64-scoped key for the OS keychain on Unix.
#[cfg(unix)]
fn steam_secret_key(steam_id: &str) -> String {
    format!("steam_refresh_{steam_id}")
}

fn session_from_stored(stored: StoredSession) -> Option<SteamSession> {
    if stored.refresh_token.trim().is_empty() {
        return None;
    }
    Some(SteamSession {
        account_name: stored.account_name,
        steam_id: stored.steam_id,
        refresh_token: stored.refresh_token,
        access_token: None,
        access_token_exp: 0,
    })
}

/// Seals the refresh token into the account vault and marks that account
/// active. Windows uses DPAPI in a file; Unix prefers the OS keychain and only
/// falls back to the 0600 file when the Secret Service is unavailable.
/// Failures are non-fatal: the session stays usable in memory.
pub fn persist_session(app: &tauri::AppHandle, session: &SteamSession) {
    use zeroize::Zeroizing;
    let stored = StoredSession {
        account_name: session.account_name.clone(),
        steam_id: session.steam_id.clone(),
        refresh_token: session.refresh_token.clone(),
        saved_at: now_secs(),
    };

    #[cfg(unix)]
    let keychain_saved = serde_json::to_string(&stored)
        .ok()
        .map(|json| crate::cloud_backup::secret_store::set(&steam_secret_key(&session.steam_id), &json).is_ok())
        .unwrap_or(false);
    #[cfg(not(unix))]
    let keychain_saved = false;

    if keychain_saved {
        let _ = std::fs::remove_file(vault_path(&auth_dir(app), &session.steam_id));
    } else {
        let Ok(json) = serde_json::to_vec(&stored).map(Zeroizing::new) else {
            return;
        };
        let Ok(mut sealed) = dpapi::protect(&json) else {
            return;
        };
        let _ = write_private(
            &vault_path(&auth_dir(app), &session.steam_id),
            &sealed,
        );
        sealed.zeroize();
    }

    let mut accounts = load_meta(&auth_dir(app));
    for account in accounts.iter_mut() {
        account.is_active = account.steam_id == session.steam_id;
    }
    match accounts
        .iter_mut()
        .find(|account| account.steam_id == session.steam_id)
    {
        Some(account) => {
            account.account_name = session.account_name.clone();
            account.last_used = now_secs();
        }
        None => accounts.push(SteamSavedAccount {
            steam_id: session.steam_id.clone(),
            account_name: session.account_name.clone(),
            last_used: now_secs(),
            is_active: true,
        }),
    }
    save_meta(&auth_dir(app), &accounts);
}

/// Marks every vault entry inactive without deleting it: signing out keeps the
/// row so the account can be switched back to.
pub fn deactivate_vault(app: &tauri::AppHandle) {
    let mut accounts = load_meta(&auth_dir(app));
    for account in accounts.iter_mut() {
        account.is_active = false;
    }
    save_meta(&auth_dir(app), &accounts);
}

pub fn read_vault_session(app: &tauri::AppHandle, steam_id: &str) -> Option<SteamSession> {
    use zeroize::Zeroizing;

    #[cfg(unix)]
    if let Some(json) = crate::cloud_backup::secret_store::get(&steam_secret_key(steam_id)) {
        if let Ok(stored) = serde_json::from_str::<StoredSession>(&json) {
            if let Some(session) = session_from_stored(stored) {
                return Some(session);
            }
        }
    }

    let sealed = std::fs::read(vault_path(&auth_dir(app), steam_id)).ok()?;
    let plain = Zeroizing::new(dpapi::unprotect(&sealed).ok()?);
    let stored: StoredSession = serde_json::from_slice(&plain).ok()?;

    // Migrate the 0600 Unix file into the keychain while the token is in hand.
    #[cfg(unix)]
    if let Ok(json) = serde_json::to_string(&stored) {
        if crate::cloud_backup::secret_store::set(&steam_secret_key(steam_id), &json).is_ok() {
            let _ = std::fs::remove_file(vault_path(&auth_dir(app), steam_id));
        }
    }

    session_from_stored(stored)
}

/// Deletes both the sealed file and the keychain entry for one account.
pub fn remove_vault_session(app: &tauri::AppHandle, steam_id: &str) {
    #[cfg(unix)]
    let _ = crate::cloud_backup::secret_store::delete(&steam_secret_key(steam_id));
    let _ = std::fs::remove_file(vault_path(&auth_dir(app), steam_id));
}

/// Reads the active sealed session back; `None` covers "no file", "another
/// user" and "tampered file".
pub fn load_stored_session(app: &tauri::AppHandle) -> Option<SteamSession> {
    let steam_id = load_meta(&auth_dir(app))
        .into_iter()
        .find(|account| account.is_active)?
        .steam_id;
    read_vault_session(app, &steam_id)
}

/// One-time migration from the old single-session file (`steam/auth.bin`).
pub fn migrate_legacy_session(app: &tauri::AppHandle) {
    let legacy = auth_dir(app).join("auth.bin");
    if !legacy.is_file() || !load_meta(&auth_dir(app)).is_empty() {
        return;
    }
    let Ok(sealed) = std::fs::read(&legacy) else {
        return;
    };
    let Ok(plain) = dpapi::unprotect(&sealed) else {
        return;
    };
    let Ok(stored) = serde_json::from_slice::<StoredSession>(&plain) else {
        return;
    };
    if stored.steam_id.is_empty() {
        return;
    }
    persist_session(
        app,
        &SteamSession {
            account_name: stored.account_name,
            steam_id: stored.steam_id,
            refresh_token: stored.refresh_token,
            access_token: None,
            access_token_exp: 0,
        },
    );
    let _ = std::fs::remove_file(&legacy);
}

/// Loads the sealed session once per process, without ever blocking the UI.
pub fn ensure_disk_checked(app: &tauri::AppHandle) {
    if lock().disk_checked {
        return;
    }
    migrate_legacy_session(app);
    let stored = load_stored_session(app);
    let mut state = lock();
    state.disk_checked = true;
    if state.session.is_none() {
        state.session = stored;
    }
}

/* ---------- Network steps used by the commands ---------- */

/// 12 random bytes as hex, used as the `sessionid` of the finalize call.
pub fn random_session_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect()
}

/// Percent-decodes a cookie value (`%7C%7C` → `||`). `+` is kept literal:
/// cookies are percent-encoded, not form-encoded.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `steamLoginSecure=<steamid>||<access token>` (percent encoded) → access token.
pub fn cookie_access_token(cookie: &str) -> Option<String> {
    let value = cookie.split(';').next()?.trim();
    let encoded = value
        .strip_prefix("steamLoginSecure=")
        .or_else(|| value.strip_prefix("steamloginsecure="))?;
    let decoded = percent_decode(encoded);
    let (_, token) = decoded.split_once("||")?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// `transfer_info` entry that installs the `steamcommunity.com` session cookie.
pub fn settoken_transfer(payload: &Value) -> Option<(String, Vec<(String, String)>)> {
    let transfers = payload.get("transfer_info").and_then(Value::as_array)?;
    let entry = transfers.iter().find(|t| {
        t.get("url")
            .and_then(Value::as_str)
            .map(|url| url.contains("steamcommunity.com/login/settoken"))
            .unwrap_or(false)
    })?;
    let url = entry.get("url").and_then(Value::as_str)?.to_string();
    let params = entry
        .get("params")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some((url, params))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Unix has no DPAPI; the file mode is what keeps the token private.
    #[test]
    fn the_vault_file_is_user_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("efxlve_vault_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token.bin");
        write_private(&path, b"refresh-token").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"refresh-token");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the token file must not be world-readable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_plain_fallback_roundtrips() {
        let sealed = dpapi::protect(b"refresh-token").expect("protect");
        assert_eq!(dpapi::unprotect(&sealed).expect("unprotect"), b"refresh-token");
    }
}

