//! Epic download, uninstall, and launch.
//!
//! Callers still use `legendary::transfers::epic_install_game` and
//! `EpicDlState`. Each file owns one job:
//!
//! | File | Owns |
//! |---|---|
//! | `parse.rs` | stderr progress lines |
//! | `paths.rs` | install root and `legendary.exe` |
//! | `guard.rs` | folders that may be deleted |
//! | `queue.rs` | the one-at-a-time queue and its monitor |
//! | `launch.rs` | start and stop a running game |
//! | `uninstall.rs` | `legendary uninstall` plus a guarded folder delete |

mod guard;
mod launch;
mod parse;
mod paths;
mod queue;
mod uninstall;

// guard.rs — helpers stay in that file (no crate-level re-export).

// launch.rs: epic_launch_game, epic_stop_game, discover_game_executables, image_inside_install, wake_main_window, game_process_pids, is_game_process_running
#[allow(unused_imports)]
pub use launch::*;

#[allow(unused_imports)]
pub use parse::{
    parse_eta,
    parse_speed,
};
#[allow(unused_imports)]
pub(crate) use parse::short_error;

// paths.rs: default_install_dir, epic_default_install_dir, epic_set_install_dir
#[allow(unused_imports)]
pub use paths::*;

// queue.rs: EpicDlState, DlProgress, DlPaused, DlQueueStatus, emit_progress_full, epic_install_game, epic_install_with_options, epic_resume_pending_download, epic_cancel_download, epic_pause_download, epic_resume_download, epic_reorder_queue, epic_get_queue
#[allow(unused_imports)]
pub use queue::*;

// uninstall.rs: epic_uninstall_game
#[allow(unused_imports)]
pub use uninstall::*;

#[cfg(test)]
mod tests;
