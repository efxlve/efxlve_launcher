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

#[allow(unused_imports)]
pub use guard::*;
#[allow(unused_imports)]
pub use launch::*;
#[allow(unused_imports)]
pub use parse::*;
#[allow(unused_imports)]
pub use paths::*;
#[allow(unused_imports)]
pub use queue::*;
#[allow(unused_imports)]
pub use uninstall::*;

#[cfg(test)]
mod tests;
