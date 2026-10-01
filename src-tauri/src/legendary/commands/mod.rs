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

pub use achievements::*;
pub use cdn::*;
pub use game_local::*;
pub use metadata::*;
pub use ops::*;
pub use session::*;
pub use verify::*;
