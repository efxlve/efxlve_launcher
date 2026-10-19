//! Linux and macOS compatibility layer.
//!
//! The launcher's store CLIs are already cross-platform, but a Windows game
//! still needs a runner and translation layers outside Windows. This module
//! owns that toolbox: a catalogue of the projects Heroic uses, a downloader for
//! their release archives, a small on-disk inventory, and the wrapper/env that
//! Epic, GOG and Amazon launches hand to the game process.
//!
//! Scope today is preparation, not a shipped Linux/macOS build: the manager can
//! download a Linux or macOS tree even from Windows, while the launch path only
//! uses it when the launcher itself runs on that platform.

mod catalog;
pub mod games;
pub mod install;
pub mod launch;

pub use launch::{launch_spec, prepare_prefix_for_launch};
