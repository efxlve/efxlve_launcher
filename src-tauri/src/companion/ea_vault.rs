//! Sealed EA account tokens.
//!
//! The access and refresh tokens are wrapped with Windows DPAPI: a copied file
//! is useless on another Windows user or machine. Nothing here is written in
//! plain text, and the file lives next to the other companion data.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::accounts::data_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct EaTokens {
    #[serde(default)]
    pub access: String,
    #[serde(default)]
    pub refresh: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub saved_at: u64,
}

fn vault_path() -> PathBuf {
    data_dir().join("ea_session.bin")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
pub(crate) fn save(tokens: &EaTokens) {
    if tokens.access.is_empty() && tokens.refresh.is_empty() {
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
pub(crate) fn save(_tokens: &EaTokens) {}

#[cfg(windows)]
pub(crate) fn load() -> Option<EaTokens> {
    let sealed = std::fs::read(vault_path()).ok()?;
    let json = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    let stored: EaTokens = serde_json::from_slice(&json).ok()?;
    if stored.access.is_empty() && stored.refresh.is_empty() {
        return None;
    }
    Some(stored)
}

#[cfg(not(windows))]
pub(crate) fn load() -> Option<EaTokens> {
    None
}

pub(crate) fn clear() {
    let _ = std::fs::remove_file(vault_path());
}
