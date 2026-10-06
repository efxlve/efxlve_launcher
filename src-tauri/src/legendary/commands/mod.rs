//! Epic/Legendary Tauri commands exposed to the frontend.
//!
//! Each file owns one responsibility. Callers still use `legendary::commands::*`.

mod achievements;
mod cdn;
mod game_local;
mod metadata;
mod ops;
mod prelude;
mod session;
mod support;
mod verify;

// achievements.rs: enrich_achievements_from_metadata, epic_get_achievements, epic_get_achievements_summary, scan_achievements_summary
#[allow(unused_imports)]
pub use achievements::*;

// cdn.rs: CdnProbe, DEFAULT_EPIC_CDNS, build_cdn_targets, epic_measure_cdns, epic_set_preferred_cdn, epic_cleanup_cache
#[allow(unused_imports)]
pub use cdn::*;

// game_local.rs: GameLocalSettings, GameCustomConfig, load_all_game_custom_configs, update_game_last_cloud_sync, resolve_save_path, sync_skipped, epic_get_game_settings, epic_save_game_settings, epic_set_custom_save_path, epic_sync_saves, remove_desktop_shortcut, epic_create_desktop_shortcut, GameDlcItem, GameDlcResponse, epic_get_game_dlcs, InstallOptionTag, GameInstallOptions, epic_get_install_options
#[allow(unused_imports)]
pub use game_local::*;

// metadata.rs: generate_slug_candidates, epic_get_hltb, epic_get_critic, epic_get_system_requirements, epic_detect_egl_games, epic_sync_egl_installed
#[allow(unused_imports)]
pub use metadata::*;

// ops.rs: GameUpdateInfo, epic_check_updates, epic_get_playtimes, epic_set_playtime, epic_get_network_profile, epic_set_network_profile, epic_get_offline_mode, epic_set_offline_mode, epic_get_auto_desktop_shortcut, epic_set_auto_desktop_shortcut, epic_backup_save, epic_list_backups, epic_restore_backup, epic_delete_backup, epic_open_backup_folder, epic_get_collections, epic_save_collection, epic_reorder_collections, epic_delete_collection, epic_set_game_collections, epic_import_egl_collections, epic_get_player_profile, epic_get_system_drives, epic_import_installed_folder, epic_select_folder_dialog, epic_move_game, epic_cancel_move_game
#[allow(unused_imports)]
pub use ops::*;

// session.rs: SetupStatus, epic_setup_status, epic_ensure_binary, epic_list_games, epic_list_skipped, CachedLibrary, epic_cached_library, epic_list_installed, epic_login_with_code, epic_import_egl, epic_logout, epic_get_saved_accounts, epic_switch_account, epic_remove_saved_account, epic_get_settings
#[allow(unused_imports)]
pub use session::*;

// verify.rs: VerifyProgressPayload, VerifyCompletePayload, ParsedVerifyProgress, parse_verify_progress, epic_verify_game
#[allow(unused_imports)]
pub use verify::*;

