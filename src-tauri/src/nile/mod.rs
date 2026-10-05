//! Amazon Games integration backed by the Nile CLI.
//!
//! Nile (<https://github.com/imLinguin/nile>, GPL-3.0) is the open-source
//! Amazon Games client Heroic uses. The launcher pins one release per build,
//! downloads it into `<app_data>/bin`, and points it at a launcher-owned
//! config directory so the library, installed list and tokens stay ours.
//!
//! This phase covers the account and the library. Install, launch and update
//! build on the same CLI.

pub mod auth;
pub mod binary;
pub mod cli;
pub mod library;
pub mod transfers;

pub use binary::{ensure_binary, resolve_binary};

/// Base folder Amazon Games install into (empty = Nile's default).
#[tauri::command]
pub fn amazon_get_install_dir(app: tauri::AppHandle) -> Option<String> {
    crate::load_settings(&app).amazon_install_dir
}

#[tauri::command]
pub fn amazon_set_install_dir(app: tauri::AppHandle, dir: String) {
    let mut s = crate::load_settings(&app);
    s.amazon_install_dir = Some(dir);
    crate::save_settings(&app, &s);
}

/// Default base folder for Amazon installs: `<home>\Games\Amazon`.
#[tauri::command]
pub fn amazon_default_install_dir() -> String {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    home.join("Games")
        .join("Amazon")
        .to_string_lossy()
        .to_string()
}
