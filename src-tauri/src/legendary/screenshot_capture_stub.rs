//! Screen capture is Windows-only.

use std::path::Path;

pub fn capture_screen_native(_target_file: &Path) -> Result<(), String> {
    Err("Native screen capture only supported on Windows".to_string())
}

/// The clip recorder's frame grabber: no native capture on this platform.
pub fn capture_frame_jpeg(_quality: u8, _target_height: u32) -> Result<(Vec<u8>, u32, u32), String> {
    Err("Screen capture only supported on Windows".to_string())
}

/// Gallery previews are generated with Windows GDI+; elsewhere the listing
/// falls back to the file itself.
pub fn make_thumbnail(_source: &Path, _target: &Path, _max_px: u32) -> Result<(), String> {
    Err("Thumbnails only supported on Windows".to_string())
}
