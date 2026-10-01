//! Sealed Ubisoft session.
//!
//! The ticket and its remember-me token are wrapped with Windows DPAPI: a
//! copied file is useless on another Windows user or machine. Nothing here is
//! written in plain text, and the file lives next to the other companion data.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::accounts::data_dir;
use super::ubisoft_login::Session;

#[derive(Serialize, Deserialize)]
pub(crate) struct StoredUbiSession {
    pub name: String,
    pub ticket: String,
    pub session_id: String,
    pub user_id: String,
    #[serde(default)]
    pub remember: String,
    pub saved_at: u64,
}

fn vault_path() -> PathBuf {
    data_dir().join("ubi_session.bin")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl StoredUbiSession {
    pub(crate) fn into_session(self) -> Session {
        Session {
            ticket: self.ticket,
            session_id: self.session_id,
            user_id: self.user_id,
            name: self.name,
            remember: self.remember,
        }
    }
}

#[cfg(windows)]
pub(crate) fn save(session: &Session) {
    if session.ticket.is_empty() && session.remember.is_empty() {
        return;
    }
    let stored = StoredUbiSession {
        name: session.name.clone(),
        ticket: session.ticket.clone(),
        session_id: session.session_id.clone(),
        user_id: session.user_id.clone(),
        remember: session.remember.clone(),
        saved_at: now_secs(),
    };
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
pub(crate) fn save(_session: &Session) {}

#[cfg(windows)]
pub(crate) fn load() -> Option<StoredUbiSession> {
    let sealed = std::fs::read(vault_path()).ok()?;
    let json = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    let stored: StoredUbiSession = serde_json::from_slice(&json).ok()?;
    if stored.ticket.is_empty() && stored.remember.is_empty() {
        return None;
    }
    Some(stored)
}

#[cfg(not(windows))]
pub(crate) fn load() -> Option<StoredUbiSession> {
    None
}

pub(crate) fn clear() {
    let _ = std::fs::remove_file(vault_path());
}
