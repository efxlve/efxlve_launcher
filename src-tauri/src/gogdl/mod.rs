//! GOG.COM integration (OAuth2, Galaxy REST APIs, and gogdl CLI worker).

pub mod accounts;
pub mod api_client;
pub mod cache;
pub mod commands;
pub mod galaxy;
pub mod galaxy_playtime;
pub mod launcher;
pub mod models;
pub mod paths;
pub mod presence;
pub mod transfers;
pub mod updates;
#[cfg(windows)]
pub mod win_job;

use thiserror::Error;

/// Stable error code the frontend recognizes as the "login required" state.
pub const NOT_AUTHENTICATED: &str = "NOT_AUTHENTICATED";

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum GogError {
    #[error("@t:err.notAuthenticated")]
    NotAuthenticated,
    #[error("@t:err.commandFailed\u{1f}{exit}\u{1f}{stderr_tail}")]
    CommandFailed { exit: i32, stderr_tail: String },
    #[error("@t:err.parse\u{1f}{0}")]
    ParseError(String),
    #[error("@t:err.binaryMissing")]
    BinaryMissing,
    #[error("@t:err.downloadFailed\u{1f}{0}")]
    DownloadFailed(String),
    #[error("@t:err.network\u{1f}{0}")]
    Http(String),
    #[error("@t:err.timeout")]
    Timeout,
    #[error("@t:err.io\u{1f}{0}")]
    Io(String),
}

impl From<std::io::Error> for GogError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            GogError::BinaryMissing
        } else {
            GogError::Io(e.to_string())
        }
    }
}

impl From<reqwest::Error> for GogError {
    fn from(e: reqwest::Error) -> Self {
        GogError::Http(e.to_string())
    }
}

impl From<serde_json::Error> for GogError {
    fn from(e: serde_json::Error) -> Self {
        GogError::ParseError(e.to_string())
    }
}

impl GogError {
    pub fn friendly(self) -> String {
        self.to_string()
    }
}

/// Error mapping for Tauri commands.
pub fn cmd_error(e: GogError) -> String {
    match e {
        GogError::NotAuthenticated => NOT_AUTHENTICATED.to_string(),
        other => other.friendly(),
    }
}
