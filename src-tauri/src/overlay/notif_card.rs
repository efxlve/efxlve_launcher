//! The notification card the launcher draws over a running game.
//!
//! It is a layered window painted with GDI+ into a 32bpp DIB and uploaded with
//! `UpdateLayeredWindow`: per-pixel alpha is the only way to get smooth rounded
//! corners, a real drop shadow and antialiased text in one surface. Plain GDI
//! painting could not (the old plate had aliased 12px corners and no shadow).
//! The window never takes focus or input.
//!
//! One card at a time: a newer notification replaces the current one, and the
//! stale animation stops on the generation counter.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicU8, Ordering};

/// Trophy tier of the unlocked achievement, mirroring the colours the
/// achievements tab already uses for `bronze`/`silver`/`gold`/`platinum`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Tier {
    /// Not an achievement: the game-start hint, the recorder notice.
    Plain,
    /// An achievement whose global unlock rate is unknown: a neutral trophy.
    Neutral,
    Bronze,
    Silver,
    Gold,
    Platinum,
}

impl Tier {
    /// `bronze` / `silver` / `gold` / `platinum` from the achievement data.
    pub fn from_name(name: Option<&str>) -> Tier {
        match name.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("bronze") => Tier::Bronze,
            Some("silver") => Tier::Silver,
            Some("gold") => Tier::Gold,
            Some("platinum") => Tier::Platinum,
            _ => Tier::Neutral,
        }
    }

    /// The accent colour, the same hexes as the achievement pills in the UI.
    fn accent(self) -> (u8, u8, u8) {
        match self {
            Tier::Bronze => (0xb0, 0x7a, 0x4f),
            Tier::Silver => (0xa9, 0xad, 0xb7),
            Tier::Gold => (0xd4, 0xa7, 0x2c),
            Tier::Platinum => (0xff, 0xff, 0xff),
            // An unknown rarity sits between the tiers, not on the game mark.
            Tier::Neutral => (0xa6, 0xa6, 0xaf),
            Tier::Plain => (0xe8, 0xe8, 0xea),
        }
    }

    /// True while the tile shows a trophy instead of the game mark.
    fn is_trophy(self) -> bool {
        self != Tier::Plain
    }
}

/// The card's content: one bold line, one muted line, one accent.
#[derive(Clone, Debug)]
pub struct Card {
    pub title: String,
    pub body: String,
    pub tier: Tier,
}

/// The monitor the card is placed on, in physical pixels.
#[derive(Copy, Clone, Debug)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel (1.0 at 100% scaling).
    pub scale: f32,
}

/// How long the next card stays on screen.
pub fn set_hold(ms: u64) {
    HOLD_MS.store(ms.clamp(2000, 15_000), Ordering::Relaxed);
}

/// Which screen corner the next card uses. `0` top-right, `1` top-left,
/// `2` bottom-right, `3` bottom-left, `4` center-top, `5` center-bottom.
pub fn set_position(position: &str) {
    POSITION.store(position_code(position), Ordering::Relaxed);
}

pub(crate) fn position_code(position: &str) -> u8 {
    match position {
        "top-left" => 1,
        "bottom-right" => 2,
        "bottom-left" => 3,
        "center-top" => 4,
        "center-bottom" => 5,
        _ => 0,
    }
}

/// True while a card owns the screen area; the metrics HUD stays off then.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

static HWND: AtomicIsize = AtomicIsize::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Bumped per card; a stale animation must not hide a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static HOLD_MS: AtomicU64 = AtomicU64::new(5200);
static POSITION: AtomicU8 = AtomicU8::new(0);

/* ---------- Layout (pure, unit-tested) ---------- */

const SHADOW: i32 = 18;
const RADIUS: f32 = 14.0;
const TILE_RADIUS: f32 = 16.0;
const PAD_LEFT: i32 = 16;
const PAD_RIGHT: i32 = 20;
const PAD_TOP: i32 = 14;
const TILE: i32 = 60;
const GAP: i32 = 16;
const TITLE_PX: f32 = 15.0;
const BODY_PX: f32 = 13.0;
const MIN_WIDTH: i32 = 348;
const MAX_WIDTH: i32 = 560;
const MARGIN: i32 = 24;

/// Every fixed size scaled to the monitor, so the card is the same size to the
/// eye on a 150% display as on a 100% one.
#[derive(Copy, Clone, Debug)]
pub(crate) struct Metrics {
    pub scale: f32,
    pub pad_left: i32,
    pub pad_right: i32,
    pub pad_top: i32,
    pub tile: i32,
    pub gap: i32,
    pub radius: f32,
    pub tile_radius: f32,
    pub title_px: f32,
    pub body_px: f32,
    pub margin: i32,
    pub shadow: i32,
    pub min_width: i32,
    pub max_width: i32,
}

impl Metrics {
    pub(crate) fn for_scale(scale: f32) -> Self {
        let scale = if scale.is_finite() { scale.clamp(1.0, 2.5) } else { 1.0 };
        let px = |value: i32| ((value as f32) * scale).round() as i32;
        Self {
            scale,
            pad_left: px(PAD_LEFT),
            pad_right: px(PAD_RIGHT),
            pad_top: px(PAD_TOP),
            tile: px(TILE),
            gap: px(GAP),
            radius: RADIUS * scale,
            tile_radius: TILE_RADIUS * scale,
            title_px: TITLE_PX * scale,
            body_px: BODY_PX * scale,
            margin: px(MARGIN),
            shadow: px(SHADOW),
            min_width: px(MIN_WIDTH),
            max_width: px(MAX_WIDTH),
        }
    }

    /// Where the text column starts, measured from the card's left edge.
    pub(crate) fn text_left(&self) -> i32 {
        self.pad_left + self.tile + self.gap
    }

    pub(crate) fn card_height(&self) -> i32 {
        self.pad_top * 2 + self.tile
    }
}

/// Card width from the widest text line, clamped to a readable range and to the
/// monitor the card has to fit on.
pub(crate) fn card_width(metrics: &Metrics, text_width: i32, screen_width: u32) -> i32 {
    let wanted = metrics.text_left() + text_width.max(0) + metrics.pad_right;
    let cap = (screen_width as i32 - 2 * metrics.margin).max(240);
    wanted.clamp(metrics.min_width, metrics.max_width).min(cap)
}

/// Top-left corner of the card (not of its shadow gutter) on the monitor.
pub(crate) fn card_box(
    screen: &Screen,
    width: i32,
    height: i32,
    position: u8,
    margin: i32,
) -> (i32, i32) {
    let left = position == 1 || position == 3;
    let center = position == 4 || position == 5;
    let bottom = position == 2 || position == 3 || position == 5;
    let x = if left {
        screen.x + margin
    } else if center {
        screen.x + (screen.width as i32 - width) / 2
    } else {
        screen.x + screen.width as i32 - width - margin
    };
    let y = if bottom {
        screen.y + screen.height as i32 - height - margin
    } else {
        screen.y + margin
    };
    (x, y)
}

/// Which way the slide-in comes from for a position.
pub(crate) fn slides_from_left(position: u8) -> bool {
    position == 1 || position == 3
}

/* ---------- Public entry points ---------- */

/// Shows a card on `screen`. A card already on screen is replaced.
pub fn show(card: Card, screen: Screen) {
    if card.title.trim().is_empty() && card.body.trim().is_empty() {
        return;
    }
    #[cfg(windows)]
    win::show(card, screen);
    #[cfg(not(windows))]
    {
        let _ = screen;
    }
}

/// Straight-alpha ARGB → premultiplied ARGB, the layout layered windows expect.
pub(crate) fn premultiply_pixel(pixel: u32) -> u32 {
    let alpha = pixel >> 24;
    if alpha == 0 {
        return 0;
    }
    if alpha == 255 {
        return pixel;
    }
    let scale = |channel: u32| ((channel * alpha + 127) / 255) & 0xFF;
    let r = scale((pixel >> 16) & 0xFF);
    let g = scale((pixel >> 8) & 0xFF);
    let b = scale(pixel & 0xFF);
    (alpha << 24) | (r << 16) | (g << 8) | b
}

/* ---------- Windows implementation ---------- */

#[cfg(windows)]
#[allow(clashing_extern_declarations)]
pub(crate) mod win {
    use super::*;
    use std::ffi::c_void;

    type Hdc = *mut c_void;
    type Hbitmap = *mut c_void;
    type Hgdiobj = *mut c_void;
    type Hwnd = isize;
    type GpGraphics = *mut c_void;
    type GpBrush = *mut c_void;
    type GpPen = *mut c_void;
    type GpPath = *mut c_void;
    type GpFont = *mut c_void;
    type GpFontFamily = *mut c_void;
    type GpStringFormat = *mut c_void;
    type GpBitmap = *mut c_void;

    /// GDI+ `PixelFormat32bppARGB`: straight (not premultiplied) alpha. The DIB
    /// is premultiplied right before it goes to `UpdateLayeredWindow`.
    const PIXEL_FORMAT_32BPP_ARGB: i32 = 0x0026_200A;
    const UNIT_PIXEL: i32 = 2;
    const SMOOTHING_ANTIALIAS: i32 = 4;
    const TEXT_ANTIALIAS_GRID_FIT: i32 = 3;
    const PIXEL_OFFSET_HIGH_QUALITY: i32 = 2;
    const COMPOSITING_QUALITY_HIGH: i32 = 2;
    const FILL_MODE_WINDING: i32 = 1;
    const LINE_CAP_ROUND: i32 = 2;
    /// `StringFormatFlagsNoWrap` + ellipsis trimming: one line, always.
    const STRING_FLAGS_NO_WRAP: i32 = 0x1000;
    const TRIM_ELLIPSIS_CHARACTER: i32 = 3;

    /* ---- Raw GDI / GDI+ / user32 bindings ---- */

    #[repr(C)]
    struct GdiplusStartupInput {
        version: u32,
        debug_event_callback: usize,
        suppress_background_thread: i32,
        suppress_external_codecs: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct BlendFunction {
        blend_op: u8,
        blend_flags: u8,
        source_constant_alpha: u8,
        alpha_format: u8,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Size {
        cx: i32,
        cy: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct RectF {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_pels: i32,
        y_pels: i32,
        clr_used: u32,
        clr_important: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    #[repr(C)]
    struct WndClassW {
        style: u32,
        wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
        cls_extra: i32,
        wnd_extra: i32,
        instance: isize,
        icon: isize,
        cursor: isize,
        background: isize,
        menu_name: *const u16,
        class_name: *const u16,
    }

    #[link(name = "gdiplus")]
    extern "system" {
        fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> i32;
        fn GdipCreateBitmapFromScan0(
            width: i32,
            height: i32,
            stride: i32,
            format: i32,
            scan0: *const u8,
            bitmap: *mut GpBitmap,
        ) -> i32;
        fn GdipGetImageGraphicsContext(image: *mut c_void, graphics: *mut GpGraphics) -> i32;
        fn GdipSetSmoothingMode(graphics: GpGraphics, mode: i32) -> i32;
        fn GdipSetTextRenderingHint(graphics: GpGraphics, hint: i32) -> i32;
        fn GdipSetPixelOffsetMode(graphics: GpGraphics, mode: i32) -> i32;
        fn GdipSetCompositingQuality(graphics: GpGraphics, quality: i32) -> i32;
        fn GdipDeleteGraphics(graphics: GpGraphics) -> i32;
        fn GdipDisposeImage(image: *mut c_void) -> i32;
        fn GdipCreatePath(fill_mode: i32, path: *mut GpPath) -> i32;
        fn GdipAddPathArc(
            path: GpPath,
            x: f32,
            y: f32,
            width: f32,
            height: f32,
            start_angle: f32,
            sweep_angle: f32,
        ) -> i32;
        fn GdipAddPathLine(path: GpPath, x1: f32, y1: f32, x2: f32, y2: f32) -> i32;
        fn GdipClosePathFigure(path: GpPath) -> i32;
        fn GdipDeletePath(path: GpPath) -> i32;
        fn GdipFillPath(graphics: GpGraphics, brush: GpBrush, path: GpPath) -> i32;
        fn GdipDrawPath(graphics: GpGraphics, pen: GpPen, path: GpPath) -> i32;
        fn GdipCreateSolidFill(color: u32, brush: *mut GpBrush) -> i32;
        fn GdipDeleteBrush(brush: GpBrush) -> i32;
        fn GdipCreatePen1(color: u32, width: f32, unit: i32, pen: *mut GpPen) -> i32;
        fn GdipSetPenStartCap(pen: GpPen, cap: i32) -> i32;
        fn GdipSetPenEndCap(pen: GpPen, cap: i32) -> i32;
        fn GdipDeletePen(pen: GpPen) -> i32;
        fn GdipCreateFontFamilyFromName(
            name: *const u16,
            collection: *mut c_void,
            family: *mut GpFontFamily,
        ) -> i32;
        fn GdipCreateFont(family: GpFontFamily, size: f32, style: i32, unit: i32, font: *mut GpFont) -> i32;
        fn GdipDeleteFont(font: GpFont) -> i32;
        fn GdipDeleteFontFamily(family: GpFontFamily) -> i32;
        fn GdipCreateStringFormat(attributes: i32, language: u16, format: *mut GpStringFormat) -> i32;
        fn GdipSetStringFormatFlags(format: GpStringFormat, flags: i32) -> i32;
        fn GdipSetStringFormatTrimming(format: GpStringFormat, trimming: i32) -> i32;
        fn GdipDeleteStringFormat(format: GpStringFormat) -> i32;
        fn GdipDrawString(
            graphics: GpGraphics,
            text: *const u16,
            length: i32,
            font: GpFont,
            layout: *const RectF,
            format: GpStringFormat,
            brush: GpBrush,
        ) -> i32;
        fn GdipMeasureString(
            graphics: GpGraphics,
            text: *const u16,
            length: i32,
            font: GpFont,
            layout: *const RectF,
            format: GpStringFormat,
            bounds: *mut RectF,
            codepoints: *mut i32,
            lines: *mut i32,
        ) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn DeleteDC(hdc: Hdc) -> i32;
        fn CreateDIBSection(
            hdc: Hdc,
            info: *const BitmapInfo,
            usage: u32,
            bits: *mut *mut c_void,
            section: *mut c_void,
            offset: u32,
        ) -> Hbitmap;
        fn SelectObject(hdc: Hdc, object: Hgdiobj) -> Hgdiobj;
        fn DeleteObject(object: Hgdiobj) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetDC(hwnd: Hwnd) -> Hdc;
        fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
        fn RegisterClassW(class: *const WndClassW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: isize,
            instance: isize,
            param: isize,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn UpdateLayeredWindow(
            hwnd: Hwnd,
            dst: Hdc,
            dst_point: *const Point,
            size: *const Size,
            src: Hdc,
            src_point: *const Point,
            color_key: u32,
            blend: *const BlendFunction,
            flags: u32,
        ) -> i32;
        fn GetMessageW(message: *mut u8, hwnd: Hwnd, min: u32, max: u32) -> i32;
        fn TranslateMessage(message: *const u8) -> i32;
        fn DispatchMessageW(message: *const u8) -> isize;
        fn PostQuitMessage(code: i32);
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> isize;
    }

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const WM_ERASEBKGND: u32 = 0x0014;
    const WM_NCHITTEST: u32 = 0x0084;
    const HTTRANSPARENT: isize = -1;
    const SW_SHOWNOACTIVATE: i32 = 4;
    const SW_HIDE: i32 = 0;
    const ULW_ALPHA: u32 = 2;

    /* ---- Colours: ARGB, matching the launcher's tokens ---- */

    const SURFACE: u32 = 0xF5_10_10_14;
    const BORDER: u32 = 0x1A_FF_FF_FF;
    const TEXT: u32 = 0xFF_FF_FF_FF;
    const TEXT_DIM: u32 = 0xFF_9A_9A_9A;
    const TILE_PLAIN_FILL: u32 = 0x14_FF_FF_FF;
    const TILE_PLAIN_EDGE: u32 = 0x24_FF_FF_FF;

    fn argb(alpha: u8, (r, g, b): (u8, u8, u8)) -> u32 {
        ((alpha as u32) << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32
    }

    /* ---- GDI+ objects ---- */

    /// Brings GDI+ up once per process. Nothing shuts it down: the app is
    /// long-lived and other modules (screenshots) use it too.
    pub(crate) fn ensure_gdiplus() -> bool {
        static READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *READY.get_or_init(|| unsafe {
            let input = GdiplusStartupInput {
                version: 1,
                debug_event_callback: 0,
                suppress_background_thread: 0,
                suppress_external_codecs: 0,
            };
            let mut token: usize = 0;
            GdiplusStartup(&mut token, &input, std::ptr::null_mut()) == 0
        })
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    /// A 32bpp top-down DIB selected into a memory DC: the surface
    /// `UpdateLayeredWindow` reads from.
    pub(crate) struct Surface {
        dc: Hdc,
        bitmap: Hbitmap,
        previous: Hgdiobj,
        pub(crate) bits: *mut u8,
        pub(crate) width: i32,
        pub(crate) height: i32,
    }

    impl Surface {
        pub(crate) fn new(width: i32, height: i32) -> Option<Self> {
            unsafe {
                let dc = CreateCompatibleDC(std::ptr::null_mut());
                if dc.is_null() {
                    return None;
                }
                let info = BitmapInfo {
                    header: BitmapInfoHeader {
                        size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                        width,
                        height: -height, // top-down
                        planes: 1,
                        bit_count: 32,
                        compression: 0, // BI_RGB
                        size_image: (width * height * 4) as u32,
                        x_pels: 0,
                        y_pels: 0,
                        clr_used: 0,
                        clr_important: 0,
                    },
                    colors: [0],
                };
                let mut bits: *mut c_void = std::ptr::null_mut();
                let bitmap = CreateDIBSection(dc, &info, 0, &mut bits, std::ptr::null_mut(), 0);
                if bitmap.is_null() || bits.is_null() {
                    DeleteDC(dc);
                    return None;
                }
                let previous = SelectObject(dc, bitmap);
                Some(Self {
                    dc,
                    bitmap,
                    previous,
                    bits: bits as *mut u8,
                    width,
                    height,
                })
            }
        }

        /// Straight ARGB → premultiplied, the layout layered windows expect.
        fn premultiply(&mut self) {
            let len = (self.width * self.height) as usize * 4;
            let pixels =
                unsafe { std::slice::from_raw_parts_mut(self.bits as *mut u32, len / 4) };
            for pixel in pixels.iter_mut() {
                *pixel = premultiply_pixel(*pixel);
            }
        }

        fn present(&self, hwnd: Hwnd, x: i32, y: i32, alpha: u8) -> bool {
            let dst = Point { x, y };
            let size = Size { cx: self.width, cy: self.height };
            let src = Point { x: 0, y: 0 };
            let blend = BlendFunction {
                blend_op: 0,    // AC_SRC_OVER
                blend_flags: 1, // AC_SRC_ALPHA
                source_constant_alpha: alpha,
                alpha_format: 0,
            };
            unsafe {
                let screen = GetDC(0);
                if screen.is_null() {
                    return false;
                }
                let ok = UpdateLayeredWindow(
                    hwnd,
                    screen,
                    &dst,
                    &size,
                    self.dc,
                    &src,
                    0,
                    &blend,
                    ULW_ALPHA,
                );
                ReleaseDC(0, screen);
                ok != 0
            }
        }
    }

    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.dc, self.previous);
                DeleteObject(self.bitmap);
                DeleteDC(self.dc);
            }
        }
    }

    // The card hands its surface to the animation thread, which is the only
    // owner from then on.
    unsafe impl Send for Surface {}

    /* ---- Painting ---- */

    unsafe fn rounded_rect_path(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Option<GpPath> {
        if width <= 0.0 || height <= 0.0 {
            return None;
        }
        let radius = radius.min(width / 2.0).min(height / 2.0).max(0.0);
        let mut path: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut path) != 0 || path.is_null() {
            return None;
        }
        let d = radius * 2.0;
        let right = x + width - d;
        let bottom = y + height - d;
        // Arcs in clockwise order; GDI+ joins them with the straight edges.
        GdipAddPathArc(path, x, y, d, d, 180.0, 90.0);
        GdipAddPathArc(path, right, y, d, d, 270.0, 90.0);
        GdipAddPathArc(path, right, bottom, d, d, 0.0, 90.0);
        GdipAddPathArc(path, x, bottom, d, d, 90.0, 90.0);
        GdipClosePathFigure(path);
        Some(path)
    }

    unsafe fn fill_round_rect(g: GpGraphics, color: u32, x: f32, y: f32, w: f32, h: f32, radius: f32) {
        let Some(path) = rounded_rect_path(x, y, w, h, radius) else {
            return;
        };
        let mut brush: GpBrush = std::ptr::null_mut();
        if GdipCreateSolidFill(color, &mut brush) == 0 && !brush.is_null() {
            GdipFillPath(g, brush, path);
            GdipDeleteBrush(brush);
        }
        GdipDeletePath(path);
    }

    unsafe fn stroke_round_rect(
        g: GpGraphics,
        color: u32,
        width: f32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: f32,
    ) {
        let Some(path) = rounded_rect_path(x, y, w, h, radius) else {
            return;
        };
        let mut pen: GpPen = std::ptr::null_mut();
        if GdipCreatePen1(color, width, UNIT_PIXEL, &mut pen) == 0 && !pen.is_null() {
            GdipDrawPath(g, pen, path);
            GdipDeletePen(pen);
        }
        GdipDeletePath(path);
    }

    unsafe fn stroke_path(g: GpGraphics, color: u32, width: f32, path: GpPath) {
        let mut pen: GpPen = std::ptr::null_mut();
        if GdipCreatePen1(color, width, UNIT_PIXEL, &mut pen) == 0 && !pen.is_null() {
            GdipSetPenStartCap(pen, LINE_CAP_ROUND);
            GdipSetPenEndCap(pen, LINE_CAP_ROUND);
            GdipDrawPath(g, pen, path);
            GdipDeletePen(pen);
        }
    }

    /// Segoe UI in a semibold weight, without a separate font file. GDI+ has no
    /// 600 style, so the semibold face is used as its own family when the system
    /// has it and bold otherwise.
    unsafe fn title_family() -> Option<(GpFontFamily, i32)> {
        let name = wide("Segoe UI Semibold\0");
        let mut family: GpFontFamily = std::ptr::null_mut();
        if GdipCreateFontFamilyFromName(name.as_ptr(), std::ptr::null_mut(), &mut family) == 0
            && !family.is_null()
        {
            return Some((family, 0));
        }
        let name = wide("Segoe UI\0");
        let mut family = std::ptr::null_mut();
        if GdipCreateFontFamilyFromName(name.as_ptr(), std::ptr::null_mut(), &mut family) == 0
            && !family.is_null()
        {
            return Some((family, 1)); // FontStyleBold
        }
        None
    }

    unsafe fn body_family() -> Option<(GpFontFamily, i32)> {
        let name = wide("Segoe UI\0");
        let mut family = std::ptr::null_mut();
        if GdipCreateFontFamilyFromName(name.as_ptr(), std::ptr::null_mut(), &mut family) == 0
            && !family.is_null()
        {
            return Some((family, 0));
        }
        let name = wide("Segoe UI Variable Text\0");
        let mut family = std::ptr::null_mut();
        if GdipCreateFontFamilyFromName(name.as_ptr(), std::ptr::null_mut(), &mut family) == 0
            && !family.is_null()
        {
            return Some((family, 0));
        }
        None
    }

    struct Fonts {
        title: GpFont,
        body: GpFont,
        title_family: GpFontFamily,
        body_family: GpFontFamily,
        format: GpStringFormat,
    }

    impl Drop for Fonts {
        fn drop(&mut self) {
            unsafe {
                if !self.format.is_null() {
                    GdipDeleteStringFormat(self.format);
                }
                if !self.title.is_null() {
                    GdipDeleteFont(self.title);
                }
                if !self.body.is_null() {
                    GdipDeleteFont(self.body);
                }
                if !self.title_family.is_null() {
                    GdipDeleteFontFamily(self.title_family);
                }
                if !self.body_family.is_null() {
                    GdipDeleteFontFamily(self.body_family);
                }
            }
        }
    }

    unsafe fn fonts(metrics: &Metrics) -> Option<Fonts> {
        let (title_family, title_style) = title_family()?;
        let (body_family, _) = body_family()?;
        let mut title: GpFont = std::ptr::null_mut();
        let mut body: GpFont = std::ptr::null_mut();
        let mut format: GpStringFormat = std::ptr::null_mut();
        if GdipCreateFont(title_family, metrics.title_px, title_style, UNIT_PIXEL, &mut title) != 0
            || title.is_null()
        {
            GdipDeleteFontFamily(title_family);
            GdipDeleteFontFamily(body_family);
            return None;
        }
        if GdipCreateFont(body_family, metrics.body_px, 0, UNIT_PIXEL, &mut body) != 0 || body.is_null() {
            GdipDeleteFont(title);
            GdipDeleteFontFamily(title_family);
            GdipDeleteFontFamily(body_family);
            return None;
        }
        if GdipCreateStringFormat(0, 0, &mut format) != 0 || format.is_null() {
            GdipDeleteFont(title);
            GdipDeleteFont(body);
            GdipDeleteFontFamily(title_family);
            GdipDeleteFontFamily(body_family);
            return None;
        }
        GdipSetStringFormatFlags(format, STRING_FLAGS_NO_WRAP);
        GdipSetStringFormatTrimming(format, TRIM_ELLIPSIS_CHARACTER);
        Some(Fonts {
            title,
            body,
            title_family,
            body_family,
            format,
        })
    }

    unsafe fn measure(g: GpGraphics, font: GpFont, format: GpStringFormat, text: &str) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }
        let units = wide(text);
        let layout = RectF { x: 0.0, y: 0.0, width: 30_000.0, height: 4_000.0 };
        let mut bounds = RectF::default();
        if GdipMeasureString(
            g,
            units.as_ptr(),
            units.len() as i32,
            font,
            &layout,
            format,
            &mut bounds,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) != 0
        {
            return (0.0, 0.0);
        }
        (bounds.width.ceil(), bounds.height.ceil())
    }

    unsafe fn draw_text(
        g: GpGraphics,
        font: GpFont,
        format: GpStringFormat,
        text: &str,
        color: u32,
        rect: RectF,
    ) {
        if text.is_empty() {
            return;
        }
        let units = wide(text);
        let mut brush: GpBrush = std::ptr::null_mut();
        if GdipCreateSolidFill(color, &mut brush) != 0 || brush.is_null() {
            return;
        }
        GdipDrawString(
            g,
            units.as_ptr(),
            units.len() as i32,
            font,
            &rect,
            format,
            brush,
        );
        GdipDeleteBrush(brush);
    }

    /// Five-point mastery star, the mark the app's own platinum cup carries.
    unsafe fn draw_star(g: GpGraphics, color: u32, cx: f32, cy: f32, outer: f32, inner: f32) {
        let mut star: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut star) != 0 || star.is_null() {
            return;
        }
        let mut points = Vec::with_capacity(10);
        for step in 0..10 {
            let radius = if step % 2 == 0 { outer } else { inner };
            // Up from the top point, clockwise.
            let angle = -std::f32::consts::FRAC_PI_2 + (step as f32) * std::f32::consts::PI / 5.0;
            points.push((cx + radius * angle.cos(), cy + radius * angle.sin()));
        }
        for pair in points.windows(2) {
            GdipAddPathLine(star, pair[0].0, pair[0].1, pair[1].0, pair[1].1);
        }
        let (first, last) = (points[0], points[points.len() - 1]);
        GdipAddPathLine(star, last.0, last.1, first.0, first.1);
        GdipClosePathFigure(star);
        let mut brush: GpBrush = std::ptr::null_mut();
        if GdipCreateSolidFill(color, &mut brush) == 0 && !brush.is_null() {
            GdipFillPath(g, brush, star);
            GdipDeleteBrush(brush);
        }
        GdipDeletePath(star);
    }

    /// The trophy cup, in a 24×24 box scaled into `size`. Filled bowl, round
    /// handles, a stem and the tiered base the achievement rows already use.
    unsafe fn draw_cup(g: GpGraphics, color: u32, x: f32, y: f32, size: f32, star: Option<u32>) {
        let unit = size / 24.0;
        let at = |value: f32| value * unit;
        let map = |px: f32, py: f32| (x + at(px), y + at(py));

        // Bowl: flat top, semicircular bottom.
        let mut bowl: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut bowl) == 0 && !bowl.is_null() {
            let (left, top) = map(7.0, 4.0);
            let (right, _) = map(17.0, 4.0);
            GdipAddPathLine(bowl, left, top, right, top);
            GdipAddPathArc(bowl, left, top, at(10.0), at(10.0), 0.0, 180.0);
            GdipClosePathFigure(bowl);
            let mut brush: GpBrush = std::ptr::null_mut();
            if GdipCreateSolidFill(color, &mut brush) == 0 && !brush.is_null() {
                GdipFillPath(g, brush, bowl);
                GdipDeleteBrush(brush);
            }
            GdipDeletePath(bowl);
        }

        // Handles: a circle arc on each side, clipped by the bowl.
        for (center_x, start) in [(7.2_f32, 90.0_f32), (16.8, 270.0)] {
            let mut handle: GpPath = std::ptr::null_mut();
            if GdipCreatePath(FILL_MODE_WINDING, &mut handle) == 0 && !handle.is_null() {
                let (hx, hy) = map(center_x - 2.8, 7.6 - 2.8);
                GdipAddPathArc(handle, hx, hy, at(5.6), at(5.6), start, 180.0);
                stroke_path(g, color, at(1.5), handle);
                GdipDeletePath(handle);
            }
        }

        // Stem and the two base bars.
        let (stem_x, stem_y) = map(12.0, 14.0);
        let (_, stem_end) = map(12.0, 18.4);
        let mut stem: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut stem) == 0 && !stem.is_null() {
            GdipAddPathLine(stem, stem_x, stem_y, stem_x, stem_end);
            stroke_path(g, color, at(2.0), stem);
            GdipDeletePath(stem);
        }
        let (base1_x, base1_y) = map(8.8, 19.6);
        let (base1_x2, _) = map(15.2, 19.6);
        let (base2_x, base2_y) = map(6.6, 21.6);
        let (base2_x2, _) = map(17.4, 21.6);
        let mut base: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut base) == 0 && !base.is_null() {
            GdipAddPathLine(base, base1_x, base1_y, base1_x2, base1_y);
            stroke_path(g, color, at(1.7), base);
            GdipDeletePath(base);
        }
        let mut base2: GpPath = std::ptr::null_mut();
        if GdipCreatePath(FILL_MODE_WINDING, &mut base2) == 0 && !base2.is_null() {
            GdipAddPathLine(base2, base2_x, base2_y, base2_x2, base2_y);
            stroke_path(g, color, at(2.2), base2);
            GdipDeletePath(base2);
        }

        // Platinum carries the mastery star in its bowl, like the app's cup.
        if let Some(mark) = star {
            let (center_x, center_y) = map(12.0, 8.1);
            draw_star(g, mark, center_x, center_y, at(2.5), at(1.1));
        }
    }

    /// The launcher's game mark from the Segoe MDL2 set, for the plain card.
    unsafe fn draw_game_glyph(g: GpGraphics, color: u32, x: f32, y: f32, size: f32) {
        let name = wide("Segoe MDL2 Assets\0");
        let mut family: GpFontFamily = std::ptr::null_mut();
        if GdipCreateFontFamilyFromName(name.as_ptr(), std::ptr::null_mut(), &mut family) != 0
            || family.is_null()
        {
            // No glyph font: a simple rounded mark keeps the tile alive.
            fill_round_rect(
                g,
                color,
                x + size * 0.16,
                y + size * 0.3,
                size * 0.68,
                size * 0.4,
                size * 0.12,
            );
            return;
        }
        let mut font: GpFont = std::ptr::null_mut();
        if GdipCreateFont(family, size, 0, UNIT_PIXEL, &mut font) == 0 && !font.is_null() {
            let glyph: [u16; 1] = [0xE7FC]; // Segoe MDL2 "Game"
            let mut brush: GpBrush = std::ptr::null_mut();
            if GdipCreateSolidFill(color, &mut brush) == 0 && !brush.is_null() {
                let layout = RectF { x, y: y - size * 0.06, width: size, height: size * 1.2 };
                let mut format: GpStringFormat = std::ptr::null_mut();
                if GdipCreateStringFormat(0, 0, &mut format) == 0 && !format.is_null() {
                    GdipSetStringFormatFlags(format, STRING_FLAGS_NO_WRAP);
                    GdipDrawString(g, glyph.as_ptr(), 1, font, &layout, format, brush);
                    GdipDeleteStringFormat(format);
                }
                GdipDeleteBrush(brush);
            }
            GdipDeleteFont(font);
        }
        GdipDeleteFontFamily(family);
    }

    /// Paints one card into a fresh surface. The surface holds an alpha channel;
    /// the caller premultiplies it before presenting.
    pub(crate) unsafe fn render(
        card: &Card,
        metrics: &Metrics,
        width: i32,
        height: i32,
    ) -> Option<Surface> {
        let surface = Surface::new(width, height)?;
        let mut bitmap: GpBitmap = std::ptr::null_mut();
        if GdipCreateBitmapFromScan0(
            width,
            height,
            width * 4,
            PIXEL_FORMAT_32BPP_ARGB,
            surface.bits as *const u8,
            &mut bitmap,
        ) != 0
            || bitmap.is_null()
        {
            return Some(surface);
        }
        let mut g: GpGraphics = std::ptr::null_mut();
        if GdipGetImageGraphicsContext(bitmap, &mut g) != 0 || g.is_null() {
            GdipDisposeImage(bitmap);
            return Some(surface);
        }
        GdipSetSmoothingMode(g, SMOOTHING_ANTIALIAS);
        GdipSetTextRenderingHint(g, TEXT_ANTIALIAS_GRID_FIT);
        GdipSetPixelOffsetMode(g, PIXEL_OFFSET_HIGH_QUALITY);
        GdipSetCompositingQuality(g, COMPOSITING_QUALITY_HIGH);

        let shadow = metrics.shadow as f32;
        let card_x = shadow;
        let card_y = shadow;
        let card_w = (width as f32) - shadow * 2.0;
        let card_h = (height as f32) - shadow * 2.0;

        // Drop shadow: the same rounded rect stroked with progressively wider,
        // very transparent black pens. Half of every stroke falls outside the
        // card, and the card is painted over the inside, so the visible part is
        // a soft falloff instead of a hard edge.
        for (index, width_px) in [20.0_f32, 16.0, 12.0, 8.0, 5.0, 2.0].iter().enumerate() {
            let alpha = if index == 0 { 8 } else { 10 };
            stroke_round_rect(
                g,
                argb(alpha, (0, 0, 0)),
                *width_px * metrics.scale,
                card_x,
                card_y + 2.0 * metrics.scale,
                card_w,
                card_h,
                metrics.radius,
            );
        }

        fill_round_rect(g, SURFACE, card_x, card_y, card_w, card_h, metrics.radius);
        stroke_round_rect(
            g,
            BORDER,
            1.0,
            card_x + 0.5,
            card_y + 0.5,
            card_w - 1.0,
            card_h - 1.0,
            metrics.radius - 0.5,
        );

        // Accent tile: tier-tinted fill, tier ring, cup.
        let accent = card.tier.accent();
        let tile_x = card_x + metrics.pad_left as f32;
        let tile_y = card_y + metrics.pad_top as f32;
        let tile = metrics.tile as f32;
        let (fill, edge) = match card.tier {
            // No tier known, or no achievement at all: no accent either.
            Tier::Plain | Tier::Neutral => (TILE_PLAIN_FILL, TILE_PLAIN_EDGE),
            // Platinum is white-on-dark: a white cup on a white-tinted tile
            // reads as one grey blob, and the tier has to survive a glance.
            Tier::Platinum => (0xE6_0A_0A_0D, argb(205, accent)),
            _ => (argb(38, accent), argb(120, accent)),
        };
        fill_round_rect(g, fill, tile_x, tile_y, tile, tile, metrics.tile_radius);
        stroke_round_rect(
            g,
            edge,
            1.0,
            tile_x + 0.5,
            tile_y + 0.5,
            tile - 1.0,
            tile - 1.0,
            metrics.tile_radius - 0.5,
        );
        let glyph = tile * 0.5;
        let glyph_x = tile_x + (tile - glyph) / 2.0;
        let glyph_y = tile_y + (tile - glyph) / 2.0;
        if card.tier.is_trophy() {
            // An unknown rarity is drawn dimmer: a muted cup says "achievement"
            // without pretending to be a tier the data did not provide.
            let ink = match card.tier {
                Tier::Neutral => argb(150, accent),
                _ => argb(255, accent),
            };
            let star = (card.tier == Tier::Platinum).then_some(0xFF_0A_0A_0D);
            draw_cup(g, ink, glyph_x, glyph_y, glyph, star);
        } else {
            draw_game_glyph(g, 0xF2_FF_FF_FF, glyph_x, glyph_y, glyph);
        }

        let Some(fonts) = fonts(metrics) else {
            GdipDeleteGraphics(g);
            GdipDisposeImage(bitmap);
            return Some(surface);
        };
        let text_w = (card_w - metrics.text_left() as f32 - metrics.pad_right as f32).max(1.0);
        let (_, title_h) = measure(g, fonts.title, fonts.format, &card.title);
        let (_, body_h) = measure(g, fonts.body, fonts.format, &card.body);
        let gap_y = 2.0 * metrics.scale;
        let block = if card.body.trim().is_empty() {
            title_h
        } else {
            title_h + gap_y + body_h
        };
        let text_x = card_x + metrics.text_left() as f32;
        let mut text_y = card_y + (card_h - block) / 2.0 - 1.0 * metrics.scale;
        draw_text(
            g,
            fonts.title,
            fonts.format,
            &card.title,
            TEXT,
            RectF { x: text_x, y: text_y, width: text_w, height: title_h + 4.0 },
        );
        if !card.body.trim().is_empty() {
            text_y += title_h + gap_y;
            draw_text(
                g,
                fonts.body,
                fonts.format,
                &card.body,
                TEXT_DIM,
                RectF { x: text_x, y: text_y, width: text_w, height: body_h + 4.0 },
            );
        }

        drop(fonts);
        GdipDeleteGraphics(g);
        GdipDisposeImage(bitmap);
        Some(surface)
    }

    /* ---- Window ---- */

    /// Creates the layered window on its own thread and pumps its message loop.
    fn ensure_window() -> Hwnd {
        let existing = HWND.load(Ordering::SeqCst);
        if existing != 0 {
            return existing;
        }
        if !STARTED.swap(true, Ordering::SeqCst) {
            std::thread::spawn(|| unsafe {
                let class_name = wide("EfxlveNotifCard\0");
                let class = WndClassW {
                    style: 0,
                    wnd_proc: Some(window_proc),
                    cls_extra: 0,
                    wnd_extra: 0,
                    instance: GetModuleHandleW(std::ptr::null()),
                    icon: 0,
                    cursor: 0,
                    background: 0,
                    menu_name: std::ptr::null(),
                    class_name: class_name.as_ptr(),
                };
                RegisterClassW(&class);
                let hwnd = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    WS_POPUP,
                    0,
                    0,
                    1,
                    1,
                    0,
                    0,
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                if hwnd == 0 {
                    return;
                }
                HWND.store(hwnd, Ordering::SeqCst);
                let mut message = [0u8; 128];
                while GetMessageW(message.as_mut_ptr(), 0, 0, 0) > 0 {
                    TranslateMessage(message.as_ptr());
                    DispatchMessageW(message.as_ptr());
                }
            });
        }
        // The first card must not be lost to the creation race.
        for _ in 0..50 {
            let hwnd = HWND.load(Ordering::SeqCst);
            if hwnd != 0 {
                return hwnd;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        0
    }

    unsafe extern "system" fn window_proc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize {
        match message {
            WM_ERASEBKGND => 1,
            WM_NCHITTEST => HTTRANSPARENT,
            0x0002 /* WM_DESTROY */ => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Width of the widest line, measured with the very fonts the card paints.
    /// The card is sized to its text, so this runs before the real surface
    /// exists and measures on a one-pixel scratch bitmap.
    pub(crate) fn measure_text_width(card: &Card, metrics: &Metrics) -> i32 {
        unsafe {
            let Some(surface) = Surface::new(1, 1) else {
                return 0;
            };
            let mut bitmap: GpBitmap = std::ptr::null_mut();
            let wrapped = GdipCreateBitmapFromScan0(
                1,
                1,
                4,
                PIXEL_FORMAT_32BPP_ARGB,
                surface.bits as *const u8,
                &mut bitmap,
            );
            if wrapped != 0 || bitmap.is_null()
            {
                return 0;
            }
            let mut g: GpGraphics = std::ptr::null_mut();
            if GdipGetImageGraphicsContext(bitmap, &mut g) != 0 || g.is_null() {
                GdipDisposeImage(bitmap);
                return 0;
            }
            GdipSetTextRenderingHint(g, TEXT_ANTIALIAS_GRID_FIT);
            let width = match fonts(metrics) {
                Some(fonts) => {
                    let (title_w, _) = measure(g, fonts.title, fonts.format, &card.title);
                    let (body_w, _) = measure(g, fonts.body, fonts.format, &card.body);
                    title_w.max(body_w).round() as i32
                }
                None => 0,
            };
            GdipDeleteGraphics(g);
            GdipDisposeImage(bitmap);
            width
        }
    }

    pub(super) fn show(card: Card, screen: Screen) {
        if !ensure_gdiplus() {
            return;
        }
        let hwnd = ensure_window();
        if hwnd == 0 {
            return;
        }
        // This card supersedes whatever animation is still on screen.
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let metrics = Metrics::for_scale(screen.scale);
        let width = card_width(&metrics, measure_text_width(&card, &metrics), screen.width);
        let height = metrics.card_height();
        let surface = unsafe {
            render(
                &card,
                &metrics,
                width + metrics.shadow * 2,
                height + metrics.shadow * 2,
            )
        };
        let Some(mut surface) = surface else {
            return;
        };
        surface.premultiply();

        let position = POSITION.load(Ordering::Relaxed);
        let (card_x, card_y) = card_box(&screen, width, height, position, metrics.margin);
        let x = card_x - metrics.shadow;
        let y = card_y - metrics.shadow;
        let from_left = slides_from_left(position);
        let centered = position == 4 || position == 5;
        let start_x = if centered {
            x
        } else if from_left {
            screen.x - surface.width - 8
        } else {
            screen.x + screen.width as i32 + 8
        };
        let hold = HOLD_MS.load(Ordering::Relaxed);

        ACTIVE.store(true, Ordering::Relaxed);

        std::thread::spawn(move || {
            surface.present(hwnd, start_x, y, 0);
            unsafe {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            // Slide in: 180ms ease-out, fading up in the first third.
            const STEPS: i32 = 18;
            for step in 0..=STEPS {
                if GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                let t = step as f32 / STEPS as f32;
                let eased = 1.0 - (1.0 - t).powi(3);
                let x_now = start_x + ((x - start_x) as f32 * eased) as i32;
                let alpha = (255.0 * (t * 3.0).min(1.0)) as u8;
                surface.present(hwnd, x_now, y, alpha);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let deadline = now_ms() + hold;
            while GENERATION.load(Ordering::SeqCst) == generation && now_ms() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            // Slide out the way it came in.
            const OUT_STEPS: i32 = 12;
            let end_x = if centered {
                x
            } else if from_left {
                screen.x - surface.width - 40
            } else {
                screen.x + screen.width as i32 + 40
            };
            for step in 0..=OUT_STEPS {
                if GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                let t = step as f32 / OUT_STEPS as f32;
                let eased = t * t;
                let x_now = x + ((end_x - x) as f32 * eased) as i32;
                let alpha = (255.0 * (1.0 - t)) as u8;
                surface.present(hwnd, x_now, y, alpha);
                std::thread::sleep(std::time::Duration::from_millis(12));
            }
            if GENERATION.load(Ordering::SeqCst) == generation {
                ACTIVE.store(false, Ordering::Relaxed);
                unsafe {
                    ShowWindow(hwnd, SW_HIDE);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tier_keeps_its_accent() {
        assert_eq!(Tier::from_name(Some("Bronze")), Tier::Bronze);
        assert_eq!(Tier::from_name(Some("gold")), Tier::Gold);
        assert_eq!(Tier::from_name(Some(" platinum ")), Tier::Platinum);
        // An achievement with no rarity still gets a trophy, never the game mark.
        assert_eq!(Tier::from_name(None), Tier::Neutral);
        assert_eq!(Tier::from_name(Some("mighty")), Tier::Neutral);
        assert!(Tier::Neutral.is_trophy());
        assert!(!Tier::Plain.is_trophy());
        assert_eq!(Tier::Gold.accent(), (0xd4, 0xa7, 0x2c));
    }

    #[test]
    fn premultiplying_keeps_every_channel_below_alpha() {
        let pixel = 0x80_FF_80_40;
        let out = premultiply_pixel(pixel);
        assert_eq!(out >> 24, 0x80);
        assert!(((out >> 16) & 0xFF) <= 0x80);
        assert!(((out >> 8) & 0xFF) <= 0x80);
        assert_eq!(premultiply_pixel(0x00_FF_FF_FF), 0);
        assert_eq!(premultiply_pixel(0xFF_12_34_56), 0xFF_12_34_56);
    }

    #[test]
    fn the_card_grows_with_the_text_and_stops_at_the_monitor() {
        let metrics = Metrics::for_scale(1.0);
        let narrow = card_width(&metrics, 40, 1920);
        let wide = card_width(&metrics, 900, 1920);
        assert_eq!(narrow, metrics.min_width);
        assert!(wide > narrow);
        assert_eq!(wide, metrics.max_width);
        // On a small monitor the card gives up width instead of leaving the screen.
        let squeezed = card_width(&metrics, 900, 500);
        assert_eq!(squeezed, 500 - 2 * metrics.margin);
    }

    #[test]
    fn the_card_sits_in_every_corner() {
        let screen = Screen { x: 100, y: 50, width: 1600, height: 900, scale: 1.0 };
        let metrics = Metrics::for_scale(1.0);
        let (x, y) = card_box(&screen, 400, 88, position_code("top-right"), metrics.margin);
        assert_eq!(x + 400 + metrics.margin, screen.x + screen.width as i32);
        assert_eq!(y, screen.y + metrics.margin);
        let (left_x, _) = card_box(&screen, 400, 88, position_code("top-left"), metrics.margin);
        assert_eq!(left_x, screen.x + metrics.margin);
        let (_, bottom_y) = card_box(&screen, 400, 88, position_code("bottom-right"), metrics.margin);
        assert_eq!(bottom_y + 88 + metrics.margin, screen.y + screen.height as i32);
        let (center_x, _) = card_box(&screen, 400, 88, position_code("center-top"), metrics.margin);
        assert_eq!(center_x, screen.x + (screen.width as i32 - 400) / 2);
        // An unknown position falls back to the top right.
        assert_eq!(position_code("sideways"), 0);
    }

    #[test]
    fn the_card_scales_with_the_monitor_dpi() {
        let plain = Metrics::for_scale(1.0);
        let retina = Metrics::for_scale(1.5);
        assert_eq!(plain.card_height(), 88);
        assert_eq!(retina.card_height(), 132);
        assert!(retina.title_px > plain.title_px);
        // A nonsense scale never breaks the layout.
        assert_eq!(Metrics::for_scale(f32::NAN).scale, 1.0);
        assert_eq!(Metrics::for_scale(0.2).scale, 1.0);
    }

    /// Paints a real card offscreen: the shadow gutter stays transparent, the
    /// face is opaque, and the tier tile carries its warm accent. Guards the
    /// whole GDI+ pipeline, which a layout test cannot see.
    #[cfg(windows)]
    #[test]
    fn the_card_paints_a_face_and_leaves_the_gutter_transparent() {
        use super::win;

        assert!(win::ensure_gdiplus(), "GDI+ starts");
        let metrics = Metrics::for_scale(1.0);
        let card = Card {
            title: "First Steps".into(),
            body: "Complete the tutorial without dying.".into(),
            tier: Tier::Gold,
        };
        let width = card_width(&metrics, 200, 1920) + metrics.shadow * 2;
        let height = metrics.card_height() + metrics.shadow * 2;
        let surface = unsafe { win::render(&card, &metrics, width, height) }.expect("a surface");

        // The DIB is 32bpp BGRA, top-down, straight alpha in the last byte.
        let pixel = |x: i32, y: i32| -> [u8; 4] {
            let offset = ((y * surface.width + x) * 4) as usize;
            unsafe {
                let at = surface.bits.add(offset);
                [*at, *at.add(1), *at.add(2), *at.add(3)]
            }
        };

        assert_eq!(pixel(0, 0)[3], 0, "the shadow gutter starts transparent");
        let face = pixel(metrics.shadow + metrics.text_left(), metrics.shadow + metrics.card_height() / 2);
        assert!(face[3] >= 240, "the card face is opaque, got {}", face[3]);
        let tile = pixel(
            metrics.shadow + metrics.pad_left + metrics.tile / 2,
            metrics.shadow + metrics.pad_top + 6,
        );
        assert!(tile[3] >= 240, "the tile is opaque, got {}", tile[3]);
        assert!(tile[2] > tile[0], "gold reads warm: r={} b={}", tile[2], tile[0]);
    }
}
