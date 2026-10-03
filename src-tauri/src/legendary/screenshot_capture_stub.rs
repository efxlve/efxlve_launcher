//! Screen capture is Windows-only.

use std::path::Path;

pub fn capture_screen_native(_target_file: &Path) -> Result<(), String> {
    Err("Native screen capture only supported on Windows".to_string())
}

/// Gallery previews are generated with Windows GDI+; elsewhere the listing
/// falls back to the file itself.
pub fn make_thumbnail(_source: &Path, _target: &Path, _max_px: u32) -> Result<(), String> {
    Err("Thumbnails only supported on Windows".to_string())
}
