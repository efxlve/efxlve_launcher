//! Screen capture is Windows-only.

use std::path::Path;
pub fn capture_screen_native(_target_file: &Path) -> Result<(), String> {
    Err("Native screen capture only supported on Windows".to_string())
}
