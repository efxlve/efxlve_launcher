//! Sealed Microsoft account tokens.
//!
//! Only the long-lived OAuth refresh token is kept; the short-lived Xbox Live
//! (XSTS) token is re-issued on demand. The file is wrapped with Windows DPAPI,
//! so a copied file is useless on another Windows user or machine.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::accounts::data_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct XboxTokens {
    #[serde(default)]
    pub refresh: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub xuid: String,
    #[serde(default)]
    pub saved_at: u64,
}

fn vault_path() -> PathBuf {
    data_dir().join("xbox_session.bin")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
pub(crate) fn save(tokens: &XboxTokens) {
    if tokens.refresh.is_empty() {
        return;
    }
    let mut stored = tokens.clone();
    stored.saved_at = now_secs();
    let Ok(json) = serde_json::to_vec(&stored) else {
        return;
    };
    let Ok(sealed) = crate::steam_auth::vault::dpapi::protect(&json) else {
        return;
    };
    let path = vault_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, sealed);
}

#[cfg(not(windows))]
pub(crate) fn save(_tokens: &XboxTokens) {}

#[cfg(windows)]
pub(crate) fn load() -> Option<XboxTokens> {
    let sealed = std::fs::read(vault_path()).ok()?;
    let json = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    let stored: XboxTokens = serde_json::from_slice(&json).ok()?;
    if stored.refresh.is_empty() {
        return None;
    }
    Some(stored)
}

#[cfg(not(windows))]
pub(crate) fn load() -> Option<XboxTokens> {
    None
}

pub(crate) fn clear() {
    let _ = std::fs::remove_file(vault_path());
}
