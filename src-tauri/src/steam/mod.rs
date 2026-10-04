//! Steam client metadata. One folder, one job per file.
//!
//! Callers still use `crate::steam::steam_status`, `parse_vdf`, and the other
//! names below. This module reads the Steam client's files and hands actions
//! back through `steam://`. It does not replace the Steam client.

mod achievements;
mod download_live;
mod catalog;
mod cloud;
mod collections;
mod library;
mod playtime;
mod protocol;
mod runtime;
mod shots;
mod users;
mod vdf;

// achievements.rs: unix_date, read_local_achievements, steam_get_achievements, steam_get_achievements_summary
#[allow(unused_imports)]
pub use achievements::*;

// catalog.rs: SteamGameDetails, parse_appinfo_dlc_ids, parse_appinfo_developers, parse_appinfo_preload_ids, read_client_dlc_ids, strip_html, join_label_lines, parse_app_details, steam_app_developers, steam_get_game_details, steam_get_api_key, steam_set_api_key
#[allow(unused_imports)]
pub use catalog::*;

// cloud.rs: SteamCloudStatus, steam_cloud_status
#[allow(unused_imports)]
pub use cloud::*;

// collections.rs: steam_import_collections
#[allow(unused_imports)]
pub use collections::*;

#[allow(unused_imports)]
pub use library::{
    library_folders,
    SteamGame,
    parse_app_manifest,
    installed_games,
};

// playtime.rs: SteamPlaytime, read_playtimes, steam_sync_playtime
#[allow(unused_imports)]
pub use playtime::*;

// download_live.rs: SteamLiveDownload, steam_download_live
#[allow(unused_imports)]
pub use download_live::*;

// protocol.rs: SteamStatus, steam_status, steam_open_client, steam_open_downloads, steam_list_installed, steam_game_action
#[allow(unused_imports)]
pub use protocol::*;

#[allow(unused_imports)]
pub use runtime::{
    steam_install_path,
};

// shots.rs: steam_get_game_screenshots
#[allow(unused_imports)]
pub use shots::*;

#[allow(unused_imports)]
pub use users::{
    active_steam_user,
    active_steam_id,
};

#[allow(unused_imports)]
pub use vdf::{
    Vdf,
    parse_vdf,
};

