//! Steam client metadata. One folder, one job per file.
//!
//! Callers still use `crate::steam::steam_status`, `parse_vdf`, and the other
//! names below. This module reads the Steam client's files and hands actions
//! back through `steam://`. It does not replace the Steam client.

mod achievements;
mod catalog;
mod cloud;
mod library;
mod playtime;
mod protocol;
mod runtime;
mod shots;
mod users;
mod vdf;

#[allow(unused_imports)]
pub use achievements::*;
#[allow(unused_imports)]
pub use catalog::*;
#[allow(unused_imports)]
pub use cloud::*;
#[allow(unused_imports)]
pub use library::*;
#[allow(unused_imports)]
pub use playtime::*;
#[allow(unused_imports)]
pub use protocol::*;
#[allow(unused_imports)]
pub use runtime::*;
#[allow(unused_imports)]
pub use shots::*;
#[allow(unused_imports)]
pub use users::*;
#[allow(unused_imports)]
pub use vdf::*;

#[cfg(test)]
mod tests;
