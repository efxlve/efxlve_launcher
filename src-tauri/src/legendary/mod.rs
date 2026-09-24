//! Epic Games (Legendary CLI) integration.
//!
//! Phase 0 scope: binary resolution + auto-download, auth (code/import),
//! session status and library listing. Downloads/play are phases 1-2.

pub mod client;
pub mod cache;
pub mod commands;
pub mod downloader;
pub mod models;
pub mod paths;
pub mod playtime;
pub mod backup;
pub mod collections;
pub mod skip;
pub mod transfers;
pub mod hltb;
pub mod steamgrid;
pub mod profile;
pub mod critic;
pub mod screenshots;
pub mod move_game;
pub mod friends;
pub mod freegames;
pub mod accounts;

use thiserror::Error;

/// Stable error code the frontend recognises as the "login required" state.
/// Commands return this instead of `LegendaryError::NotAuthenticated`.
pub const NOT_AUTHENTICATED: &str = "NOT_AUTHENTICATED";

#[derive(Debug, Error)]
pub enum LegendaryError {
    #[error("@t:err.notAuthenticated")]
    NotAuthenticated,
    #[error("@t:err.commandFailed\u{1f}{exit}\u{1f}{stderr_tail}")]
    CommandFailed {
        exit: i32,
        stderr_tail: String,
        /// Full output for diagnostics (not sent to the UI, written to a file).
        stderr_full: String,
    },
    #[error("@t:err.parse\u{1f}{0}")]
    ParseError(String),
    #[error("@t:err.binaryMissing")]
    BinaryMissing,
    #[error("@t:err.downloadFailed\u{1f}{0}")]
    DownloadFailed(String),
    #[error("@t:err.timeout")]
    Timeout,
    #[error("@t:err.io\u{1f}{0}")]
    Io(String),
}

impl From<std::io::Error> for LegendaryError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            LegendaryError::BinaryMissing
        } else {
            LegendaryError::Io(e.to_string())
        }
    }
}

/// Transient error fingerprints: states worth retrying.
/// Each attempt runs a fresh `legendary` process with a fresh login, and partial
/// metadata is written to disk, so the remaining work shrinks every round.
pub(crate) fn transient_reason(text: &str) -> Option<&'static str> {
    if text.contains("429") || text.contains("Too Many Requests") {
        Some("rate_limit")
    } else if text.contains("401 Client Error") || text.contains("Unauthorized") {
        // The token can expire mid-sync on long runs; a new process logs in fresh.
        Some("session")
    } else if [
        "Max retries",
        "Failed to establish",
        "NameResolution",
        "Connection aborted",
        "ConnectTimeout",
        "NewConnectionError",
        "Temporary failure",
        "timed out",
    ]
    .iter()
    .any(|m| text.contains(m))
    {
        Some("network")
    } else {
        None
    }
}

impl LegendaryError {
    /// User-facing message descriptor (technical detail preserved as an argument).
    pub fn friendly(self) -> String {
        match &self {
            LegendaryError::CommandFailed { stderr_tail, .. } => match transient_reason(stderr_tail) {
                Some("rate_limit") => "@t:err.rateLimited".to_string(),
                Some("session") => "@t:err.sessionExpired".to_string(),
                Some(_) => format!("@t:err.network\u{1f}{stderr_tail}"),
                None if stderr_tail.contains("Login failed") => "@t:err.loginFailed".to_string(),
                None => self.to_string(),
            },
            _ => self.to_string(),
        }
    }
}

/// Error mapping for Tauri commands.
pub fn cmd_error(e: LegendaryError) -> String {
    match e {
        LegendaryError::NotAuthenticated => NOT_AUTHENTICATED.to_string(),
        other => other.friendly(),
    }
}
