//! Remembers the main window's size, position and maximized state.
//!
//! `tauri.conf.json` can only declare one size, so without this file every
//! launch reopened at the factory 1280×800 no matter how the user left the
//! window. The geometry lives in `<app_data>/window.json` instead of
//! `settings.json`: it describes the screen this machine ran on, not a user
//! preference, and a profile export must not carry another machine's pixels.
//!
//! Only the normal (restored) rectangle is stored. A maximized, minimized or
//! fullscreen window keeps the last normal size, so unmaximizing after a
//! restart returns to the size the user actually picked.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, Window};

/// Written next to `settings.json`.
const FILE: &str = "window.json";
/// Smaller than any window the launcher can produce; the file is corrupt.
const MIN_WINDOW_W: u32 = 320;
const MIN_WINDOW_H: u32 = 240;
/// Larger than any single display, including 8K at 200 % scaling.
const MAX_WINDOW: u32 = 12_000;
/// How much of the window must stay on a monitor to remain draggable by the
/// custom title bar.
const MIN_VISIBLE_W: u32 = 160;
const MIN_VISIBLE_H: u32 = 48;
/// A drag must not hit the disk on every pixel; write once it settles.
const SETTLE_MS: u64 = 500;

/// The geometry a restart should restore, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    /// The window was maximized when the user left it.
    #[serde(default)]
    pub maximized: bool,
}

impl WindowGeometry {
    fn rect(self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

/// A monitor rectangle in physical pixels with the OS top-left origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Intersection size in pixels; zero on each axis when they do not touch.
    fn overlap(self, other: Rect) -> (i64, i64) {
        let left = i64::from(self.x).max(i64::from(other.x));
        let top = i64::from(self.y).max(i64::from(other.y));
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        ((right - left).max(0), (bottom - top).max(0))
    }
}

/// The last normal geometry seen, kept while the window is maximized,
/// minimized or fullscreen. Only written when it changes.
static PENDING: Mutex<Option<WindowGeometry>> = Mutex::new(None);
/// Set by a move or resize; cleared when the geometry reaches the disk.
static DIRTY: AtomicBool = AtomicBool::new(false);
/// Bumped by every move and resize so the writer can wait for the drag to stop.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static STOPPED: AtomicBool = AtomicBool::new(false);

/// Applies the saved geometry to the freshly created main window.
///
/// Runs before the window is shown, so a restored size never flashes the
/// factory one first.
pub fn restore(window: &Window) {
    let monitors = monitor_rects(window);
    let saved = read_file(&window.app_handle());
    let target = saved.and_then(|saved| {
        let target = fit_to(saved, &monitors);
        if target.is_none() {
            crate::perf::write_line_global(
                "win: saved window geometry rejected; keeping the default",
            );
        }
        target
    });
    let Some(target) = target else {
        seed(window);
        return;
    };
    let _ = window.set_size(PhysicalSize::new(target.width, target.height));
    let _ = window.set_position(PhysicalPosition::new(target.x, target.y));
    if target.maximized {
        let _ = window.maximize();
    }
    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some(target);
    }
    DIRTY.store(false, Ordering::Relaxed);
    crate::perf::write_line_global(&format!(
        "win: restored {}x{} at {},{} maximized={}",
        target.width, target.height, target.x, target.y, target.maximized
    ));
}

/// Records the default geometry when no usable file exists yet, so maximizing
/// on the first run still leaves a normal size to come back to.
fn seed(window: &Window) {
    let current = capture(window, None);
    if let Ok(mut slot) = PENDING.lock() {
        *slot = current;
    }
    DIRTY.store(false, Ordering::Relaxed);
}

/// Called from the window event loop for every move and resize. Cheap on
/// purpose: a drag fires this hundreds of times and the geometry is read once
/// the window settles.
pub fn remember() {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    DIRTY.store(true, Ordering::Relaxed);
}

/// Starts the debounced writer. Detached: it only exists to move a small JSON
/// file to disk while the launcher runs.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("window-state".into())
        .spawn(move || {
            let mut seen = GENERATION.load(Ordering::Relaxed);
            while !STOPPED.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(SETTLE_MS));
                let current = GENERATION.load(Ordering::Relaxed);
                // Two quiet ticks: the drag has ended and the window state
                // (maximized, fullscreen, minimized) has settled too.
                if current == seen {
                    flush(&app);
                }
                seen = current;
            }
        })
        .ok();
}

/// Writes the pending geometry now and stops the writer.
pub fn stop(app: &AppHandle) {
    STOPPED.store(true, Ordering::Relaxed);
    flush(app);
}

/// Persists the current geometry if anything changed since the last write.
pub fn flush(app: &AppHandle) {
    if !DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(mut slot) = PENDING.lock() else {
        return;
    };
    let Some(next) = capture(&window, *slot) else {
        return;
    };
    *slot = Some(next);
    drop(slot);
    write_file(app, next);
}

/// Reads the rectangle a restart should restore.
///
/// `previous` carries the last normal rectangle while the window is maximized,
/// minimized or fullscreen: those states have no usable normal geometry, but
/// the maximized flag still has to follow the user.
fn capture(window: &Window, previous: Option<WindowGeometry>) -> Option<WindowGeometry> {
    if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return previous;
    }
    if window.is_maximized().unwrap_or(false) {
        return previous.map(|saved| WindowGeometry {
            maximized: true,
            ..saved
        });
    }
    let Ok(size) = window.inner_size() else {
        return previous;
    };
    let Ok(position) = window.outer_position() else {
        return previous;
    };
    if size.width < MIN_WINDOW_W || size.height < MIN_WINDOW_H {
        return previous;
    }
    Some(WindowGeometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: false,
    })
}

/// Fits the saved rectangle to the monitors that exist right now.
///
/// A laptop undocked from an external screen used to reopen the launcher off
/// the desktop, where it could not be grabbed; a 4K-sized window on a 1080p
/// panel used to hang off every edge. `monitors` is ordered with the primary
/// first, so it is also the fallback when none of them overlap.
fn fit_to(saved: WindowGeometry, monitors: &[Rect]) -> Option<WindowGeometry> {
    if saved.width < MIN_WINDOW_W || saved.height < MIN_WINDOW_H {
        return None;
    }
    if saved.width > MAX_WINDOW || saved.height > MAX_WINDOW {
        return None;
    }
    if monitors.is_empty() {
        return Some(saved);
    }

    let saved_rect = saved.rect();
    let mut best = monitors[0];
    let mut best_area = 0i64;
    for &monitor in monitors {
        let (width, height) = saved_rect.overlap(monitor);
        let area = width * height;
        if area > best_area {
            best_area = area;
            best = monitor;
        }
    }

    let mut next = WindowGeometry {
        width: saved.width.min(best.width),
        height: saved.height.min(best.height),
        ..saved
    };
    let (visible_w, visible_h) = next.rect().overlap(best);
    let reachable = visible_w >= i64::from(MIN_VISIBLE_W) && visible_h >= i64::from(MIN_VISIBLE_H);
    if !reachable {
        // The monitor this window lived on is gone: keep the size and put it
        // back in the middle of the screen that is actually there.
        let dx = (i64::from(best.width) - i64::from(next.width)) / 2;
        let dy = (i64::from(best.height) - i64::from(next.height)) / 2;
        next.x = best.x.saturating_add(dx as i32);
        next.y = best.y.saturating_add(dy as i32);
    } else if next.y < best.y {
        // Only the lower part is visible, so the drag bar is out of reach.
        next.y = best.y;
    }
    Some(next)
}

fn monitor_rects(window: &Window) -> Vec<Rect> {
    let mut rects = Vec::new();
    if let Ok(Some(primary)) = window.primary_monitor() {
        push_rect(&mut rects, &primary);
    }
    if let Ok(list) = window.available_monitors() {
        for monitor in &list {
            push_rect(&mut rects, monitor);
        }
    }
    rects
}

fn push_rect(out: &mut Vec<Rect>, monitor: &Monitor) {
    let size = monitor.size();
    if size.width == 0 || size.height == 0 {
        return;
    }
    let rect = Rect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: size.width,
        height: size.height,
    };
    if !out.contains(&rect) {
        out.push(rect);
    }
}

fn file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(FILE))
}

fn read_file(app: &AppHandle) -> Option<WindowGeometry> {
    let path = file_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_file(app: &AppHandle, saved: WindowGeometry) {
    let Some(path) = file_path(app) else {
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(&saved) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Write aside, then replace, so a crash mid-write cannot truncate the file.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &text).is_err() {
        return;
    }
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::write(&path, &text);
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    fn saved(width: u32, height: u32, x: i32, y: i32) -> WindowGeometry {
        WindowGeometry {
            width,
            height,
            x,
            y,
            maximized: false,
        }
    }

    #[test]
    fn keeps_geometry_that_fits_a_monitor() {
        let target = fit_to(saved(1440, 900, 120, 60), &[PRIMARY]).unwrap();
        assert_eq!(target, saved(1440, 900, 120, 60));
    }

    #[test]
    fn keeps_a_window_on_a_second_monitor_where_it_was() {
        let right = Rect {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let target = fit_to(saved(1600, 900, 2100, 100), &[PRIMARY, right]).unwrap();
        assert_eq!((target.x, target.y), (2100, 100));
    }

    #[test]
    fn centers_a_window_whose_monitor_is_gone() {
        let target = fit_to(saved(1440, 900, -3000, 200), &[PRIMARY]).unwrap();
        assert_eq!(target, saved(1440, 900, 240, 90));
    }

    #[test]
    fn shrinks_a_window_to_the_remaining_panel() {
        let target = fit_to(saved(2560, 1440, 0, 0), &[PRIMARY]).unwrap();
        assert_eq!(target, saved(1920, 1080, 0, 0));
    }

    #[test]
    fn pulls_a_title_bar_above_the_monitor_back_down() {
        let target = fit_to(saved(1440, 900, 100, -60), &[PRIMARY]).unwrap();
        assert_eq!(target, saved(1440, 900, 100, 0));
    }

    #[test]
    fn rejects_a_corrupt_size() {
        assert!(fit_to(saved(0, 0, 0, 0), &[PRIMARY]).is_none());
        assert!(fit_to(saved(40_000, 900, 0, 0), &[PRIMARY]).is_none());
    }

    #[test]
    fn a_file_without_the_maximized_flag_still_reads() {
        let parsed: WindowGeometry =
            serde_json::from_str(r#"{"width":1600,"height":900,"x":10,"y":20}"#).unwrap();
        assert!(!parsed.maximized);
        assert_eq!((parsed.width, parsed.height), (1600, 900));
    }
}
