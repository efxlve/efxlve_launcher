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

pub use binary::{ensure_binary, resolve_binary};
