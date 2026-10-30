//! Tactical crosshair: a small layered, click-through window at the centre of
//! the game monitor.
//!
//! External only: no injection and no game hooks. The shape is drawn in
//! software into a 32-bit RGBA DIB and pushed with `UpdateLayeredWindow`, so
//! the dark outline and the anti-aliased edges keep their alpha. The window is
//! hidden while the panel is open only in the sense that the panel covers it;
//! it is never tied to the panel's lifetime.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// The saved crosshair. The frontend owns the storage; Rust clamps every field
/// before it reaches the renderer.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrosshairConfig {
    pub enabled: bool,
    /// "dot", "cross", "circle" or "t".
    pub shape: String,
    /// "#rrggbb".
    pub color: String,
    /// Full span of the crosshair, in pixels.
    pub size: f32,
    /// Space left open in the middle of the arms.
    pub gap: f32,
    /// Line width of the arms.
    pub thickness: f32,
    /// 0.1 to 1.0.
    pub opacity: f32,
}

impl Default for CrosshairConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            shape: "cross".to_string(),
            color: "#ffffff".to_string(),
            size: 24.0,
            gap: 4.0,
            thickness: 2.0,
            opacity: 0.9,
        }
    }
}

static CONFIG: OnceLock<Mutex<CrosshairConfig>> = OnceLock::new();
/// The user's runtime toggle, independent of the saved `enabled` setting.
static VISIBLE: AtomicBool = AtomicBool::new(false);

fn config_state() -> &'static Mutex<CrosshairConfig> {
    CONFIG.get_or_init(|| Mutex::new(CrosshairConfig::default()))
}

/// Stores a new configuration. Disabling it hides the window immediately;
/// enabling it does not override a runtime toggle-off.
pub fn configure(config: CrosshairConfig) {
    let config = sanitize(config);
    let enabled = config.enabled;
    if let Ok(mut slot) = config_state().lock() {
        *slot = config;
    }
    if !enabled {
        set_visible(false);
    } else if VISIBLE.load(Ordering::SeqCst) {
        imp::post_update();
    }
}

/// The hotkey and the Settings toggle call this. A true value is remembered
/// even without a game; `restore` shows it when a game starts.
pub fn set_visible(visible: bool) {
    let enabled = config_state().lock().map(|config| config.enabled).unwrap_or(false);
    let visible = visible && enabled;
    VISIBLE.store(visible, Ordering::SeqCst);
    if visible && game_active() {
        imp::show();
    } else {
        imp::hide();
    }
}

/// Ctrl+Shift+X: flips the runtime visibility without touching the saved
/// setting.
pub fn toggle() {
    let enabled = config_state().lock().map(|config| config.enabled).unwrap_or(false);
    if enabled {
        set_visible(!VISIBLE.load(Ordering::SeqCst));
    }
}

/// Stores the crosshair settings from the overlay's Settings tab.
#[tauri::command]
pub fn overlay_crosshair_configure(config: CrosshairConfig) {
    configure(config);
}

/// Shows or hides the crosshair without changing the saved setting. The
/// Settings toggle and the hotkey both end up here.
#[tauri::command]
pub fn overlay_crosshair_set_visible(visible: bool) {
    set_visible(visible);
}

/// A game started: show the crosshair if the user left it visible.
pub fn restore() {
    let enabled = config_state().lock().map(|config| config.enabled).unwrap_or(false);
    if VISIBLE.load(Ordering::SeqCst) && enabled && game_active() {
        imp::show();
    } else {
        imp::hide();
    }
}

/// Hides the window but keeps the runtime preference: the next game restores it.
pub fn hide_window() {
    imp::hide();
}

/// The game window can move to another monitor; the hotkey watch calls this
/// every couple of seconds while the crosshair is visible.
pub fn reposition() {
    if VISIBLE.load(Ordering::SeqCst) {
        imp::post_update();
    }
}

fn game_active() -> bool {
    super::STATE
        .lock()
        .map(|state| !state.game_app.is_empty())
        .unwrap_or(false)
}

fn sanitize(mut config: CrosshairConfig) -> CrosshairConfig {
    config.shape = match config.shape.as_str() {
        "dot" | "cross" | "circle" | "t" => config.shape,
        _ => "cross".to_string(),
    };
    config.color = normalize_color(&config.color);
    config.size = clamp(config.size, 8.0, 64.0, 24.0);
    config.gap = clamp(config.gap, 0.0, 16.0, 4.0);
    config.thickness = clamp(config.thickness, 1.0, 5.0, 2.0);
    config.opacity = clamp(config.opacity, 0.1, 1.0, 0.9);
    config
}

fn clamp(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn normalize_color(value: &str) -> String {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{}", hex.to_ascii_lowercase())
    } else {
        "#ffffff".to_string()
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_color(value: &str) -> (u8, u8, u8) {
    let hex = value.trim_start_matches('#');
    if hex.len() == 6 {
        let red = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let green = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255);
        let blue = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255);
        (red, green, blue)
    } else {
        (255, 255, 255)
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    Dot,
    Cross,
    Circle,
    T,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn shape_of(value: &str) -> Shape {
    match value {
        "dot" => Shape::Dot,
        "circle" => Shape::Circle,
        "t" => Shape::T,
        _ => Shape::Cross,
    }
}

/// Draws the outline first, then the colour, into a premultiplied RGBA buffer.
#[cfg_attr(not(windows), allow(dead_code))]
fn render_pixels(config: &CrosshairConfig) -> (Vec<u8>, usize) {
    let size = config.size;
    let canvas = (size.ceil() as usize + 16).max(24);
    let center = canvas as f32 / 2.0;
    let half = size / 2.0;
    let gap = config.gap.min(half * 0.8);
    let shape = shape_of(&config.shape);
    let (red, green, blue) = parse_color(&config.color);
    let mut pixels = vec![0u8; canvas * canvas * 4];
    draw_shape(
        &mut pixels,
        canvas,
        shape,
        center,
        half,
        gap,
        config.thickness + 2.0,
        (0, 0, 0),
        0.85 * config.opacity,
    );
    draw_shape(
        &mut pixels,
        canvas,
        shape,
        center,
        half,
        gap,
        config.thickness,
        (red, green, blue),
        config.opacity,
    );
    (pixels, canvas)
}

#[cfg_attr(not(windows), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
fn draw_shape(
    pixels: &mut [u8],
    canvas: usize,
    shape: Shape,
    center: f32,
    half: f32,
    gap: f32,
    thickness: f32,
    color: (u8, u8, u8),
    alpha: f32,
) {
    let half_thickness = thickness / 2.0;
    for y in 0..canvas {
        for x in 0..canvas {
            let px = x as f32 + 0.5 - center;
            let py = y as f32 + 0.5 - center;
            let coverage = coverage(shape, px, py, half, gap, half_thickness);
            if coverage > 0.0 {
                blend(
                    pixels,
                    (y * canvas + x) * 4,
                    color,
                    (coverage * alpha).clamp(0.0, 1.0),
                );
            }
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn coverage(shape: Shape, px: f32, py: f32, half: f32, gap: f32, half_thickness: f32) -> f32 {
    match shape {
        Shape::Dot => {
            let radius = (half_thickness * 1.4).max(1.5);
            (radius + 0.5 - (px * px + py * py).sqrt()).clamp(0.0, 1.0)
        }
        Shape::Cross => {
            let arm = |along: f32, across: f32| -> f32 {
                if along >= gap && along <= half {
                    (half_thickness + 0.5 - across.abs()).clamp(0.0, 1.0)
                } else {
                    0.0
                }
            };
            arm(px, py)
                .max(arm(-px, py))
                .max(arm(py, px))
                .max(arm(-py, px))
        }
        Shape::Circle => {
            let radius = (half - half_thickness).max(1.0);
            let distance = (px * px + py * py).sqrt();
            (half_thickness + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0)
        }
        Shape::T => {
            let bar = if px.abs() <= half && py.abs() <= half_thickness {
                (half_thickness + 0.5 - py.abs()).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let stem = if py >= 0.0 && py <= half && px.abs() <= half_thickness {
                (half_thickness + 0.5 - px.abs()).clamp(0.0, 1.0)
            } else {
                0.0
            };
            bar.max(stem)
        }
    }
}

/// Source-over in premultiplied space: what `AC_SRC_ALPHA` expects.
#[cfg_attr(not(windows), allow(dead_code))]
fn blend(pixels: &mut [u8], index: usize, color: (u8, u8, u8), alpha: f32) {
    let source = alpha.clamp(0.0, 1.0);
    if source <= 0.0 {
        return;
    }
    let inverse = 1.0 - source;
    // A 32-bit BI_RGB DIB is BGRA in memory.
    pixels[index] = (color.2 as f32 * source + pixels[index] as f32 * inverse).round() as u8;
    pixels[index + 1] =
        (color.1 as f32 * source + pixels[index + 1] as f32 * inverse).round() as u8;
    pixels[index + 2] =
        (color.0 as f32 * source + pixels[index + 2] as f32 * inverse).round() as u8;
    pixels[index + 3] =
        (source * 255.0 + pixels[index + 3] as f32 * inverse).round() as u8;
}

#[cfg(windows)]
mod imp {
    use super::{config_state, render_pixels};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, DIB_RGB_COLORS, HBRUSH,
        HGDIOBJ, AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        PostQuitMessage, RegisterClassW, SetWindowPos, ShowWindow, TranslateMessage,
        UpdateLayeredWindow, HICON, HCURSOR, HWND_TOPMOST, MSG, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_APP, WM_DESTROY,
        WM_NCHITTEST, WNDCLASSW, WNDCLASS_STYLES, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    static WINDOW: AtomicIsize = AtomicIsize::new(0);
    static STARTED: AtomicBool = AtomicBool::new(false);

    const WM_APP_UPDATE: u32 = WM_APP + 1;
    const WM_APP_SHOW: u32 = WM_APP + 2;
    const WM_APP_HIDE: u32 = WM_APP + 3;

    pub fn show() {
        ensure_window();
        post(WM_APP_SHOW);
    }

    pub fn hide() {
        post(WM_APP_HIDE);
    }

    pub fn post_update() {
        post(WM_APP_UPDATE);
    }

    fn post(message: u32) {
        let hwnd = WINDOW.load(Ordering::Relaxed);
        if hwnd != 0 {
            unsafe {
                let _ = PostMessageW(
                    Some(HWND(hwnd as *mut c_void)),
                    message,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }
    }

    fn ensure_window() {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| unsafe {
            let class_name: Vec<u16> = "EfxlveCrosshair\0".encode_utf16().collect();
            let module = GetModuleHandleW(std::ptr::null());
            let instance = HINSTANCE(module as *mut c_void);
            let class = WNDCLASSW {
                style: WNDCLASS_STYLES(0),
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: HICON::default(),
                hCursor: HCURSOR::default(),
                hbrBackground: HBRUSH::default(),
                lpszMenuName: PCWSTR::null(),
                lpszClassName: PCWSTR(class_name.as_ptr()),
            };
            let _ = RegisterClassW(&class);
            let Ok(hwnd) = CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOPMOST
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE,
                PCWSTR(class_name.as_ptr()),
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance),
                None,
            ) else {
                return;
            };
            WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        for _ in 0..50 {
            if WINDOW.load(Ordering::SeqCst) != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_APP_UPDATE => {
                paint(hwnd, false);
                LRESULT(0)
            }
            WM_APP_SHOW => {
                paint(hwnd, true);
                LRESULT(0)
            }
            WM_APP_HIDE => {
                let _ = ShowWindow(hwnd, SW_HIDE);
                LRESULT(0)
            }
            WM_NCHITTEST => LRESULT(-1),
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    unsafe fn paint(hwnd: HWND, show: bool) {
        let config = config_state()
            .lock()
            .map(|config| config.clone())
            .unwrap_or_default();
        if !config.enabled {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        }
        let (pixels, canvas) = render_pixels(&config);
        let canvas = canvas as i32;
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: canvas,
                biHeight: -canvas,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default(); 1],
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let Ok(bitmap) = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        else {
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            return;
        };
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());

        let (left, top, width, height) = super::super::hud::monitor_rect_for(
            super::super::STATE
                .lock()
                .map(|state| state.game_hwnd)
                .unwrap_or(0),
        )
        .unwrap_or((0, 0, 1920, 1080));
        let destination = POINT {
            x: left + (width as i32 - canvas) / 2,
            y: top + (height as i32 - canvas) / 2,
        };
        let size = SIZE {
            cx: canvas,
            cy: canvas,
        };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
            hwnd,
            Some(screen),
            Some(&destination),
            Some(&size),
            Some(memory),
            Some(&source),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
        SelectObject(memory, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        if show {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> isize;
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn show() {}
    pub fn hide() {}
    pub fn post_update() {}
}

#[cfg(test)]
mod tests {
    use super::{normalize_color, render_pixels, sanitize, CrosshairConfig};

    fn config(shape: &str) -> CrosshairConfig {
        CrosshairConfig {
            enabled: true,
            shape: shape.to_string(),
            color: "#ffffff".to_string(),
            size: 24.0,
            gap: 0.0,
            thickness: 2.0,
            opacity: 1.0,
        }
    }

    #[test]
    fn colors_are_normalized_or_replaced() {
        assert_eq!(normalize_color("#AABBCC"), "#aabbcc");
        assert_eq!(normalize_color("aabbcc"), "#aabbcc");
        assert_eq!(normalize_color("nope"), "#ffffff");
        assert_eq!(normalize_color("#12345"), "#ffffff");
    }

    #[test]
    fn out_of_range_settings_are_clamped() {
        let mut value = config("cross");
        value.size = 500.0;
        value.gap = -4.0;
        value.thickness = 99.0;
        value.opacity = f32::NAN;
        let value = sanitize(value);
        assert_eq!(value.size, 64.0);
        assert_eq!(value.gap, 0.0);
        assert_eq!(value.thickness, 5.0);
        assert_eq!(value.opacity, 0.9);
    }

    #[test]
    fn a_cross_paints_the_arm_and_leaves_the_corner_clear() {
        let (pixels, canvas) = render_pixels(&config("cross"));
        let center = canvas / 2;
        let arm = (center * canvas + center + 6) * 4;
        assert!(pixels[arm + 3] > 0, "the right arm must be painted");
        assert_eq!(pixels[3], 0, "the corner must stay transparent");
    }

    #[test]
    fn a_circle_leaves_the_centre_open() {
        let (pixels, canvas) = render_pixels(&config("circle"));
        let center = canvas / 2;
        let middle = (center * canvas + center) * 4;
        assert_eq!(pixels[middle + 3], 0, "the ring must leave the centre open");
        let ring = (center * canvas + center + 11) * 4;
        assert!(pixels[ring + 3] > 0, "the ring must be painted");
    }
}
