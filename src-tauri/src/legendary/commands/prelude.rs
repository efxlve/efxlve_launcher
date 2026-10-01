//! Imports shared by the Epic command modules.
//!
//! A glob re-export keeps each command file free of a repeated import header.
//! Unused names are expected: not every module calls every helper.

#![allow(unused_imports)]

pub(super) use serde::{Deserialize, Serialize};
pub(super) use std::path::{Path, PathBuf};
pub(super) use std::time::Duration;
pub(super) use tauri::{AppHandle, Emitter, Manager};

pub(super) use super::support::{config_dir_for, fail, resolve_or_err, run_with_recovery};
pub(super) use crate::legendary::{
    cache, client, downloader, models::*, paths, skip, transient_reason, LegendaryError,
};
pub(super) use crate::{load_settings, save_settings};
