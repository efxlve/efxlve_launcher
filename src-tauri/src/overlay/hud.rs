//! Native always-on mini HUD (FPS / CPU / GPU plate), the game-start
//! notification card, and small window helpers.
//!
//! A WebView2 window cannot be per-pixel transparent and click-through at the
//! same time on Windows, so both surfaces are plain GDI on one layered,
//! topmost, never-activating window: a dark strip for the HUD, and a rounded
//! card (icon disc, bold title, muted body) for notifications. It never takes
//! input.
//!
//! Some Win32 functions are declared with different handle types in other
//! modules of this crate; the ABI is identical, so the clash warning is noise.
#![allow(clashing_extern_declarations)]

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

static STARTED: AtomicBool = AtomicBool::new(false);
static HWND: AtomicIsize = AtomicIsize::new(0);
static FONT: AtomicIsize = AtomicIsize::new(0);
static TAG_FONT: AtomicIsize = AtomicIsize::new(0);
static TITLE_FONT: AtomicIsize = AtomicIsize::new(0);
static BODY_FONT: AtomicIsize = AtomicIsize::new(0);
static ICON_FONT: AtomicIsize = AtomicIsize::new(0);
/// 0 compact, 1 normal (default), 2 large, 3 huge.
static NOTIF_SIZE: AtomicU8 = AtomicU8::new(1);
static SIZE_TAG_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_TITLE_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_BODY_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_ICON_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static TEXT: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// A notification card owns the plate while this is true.
static NOTIF_ON: AtomicBool = AtomicBool::new(false);
static NOTIF_TAG: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static NOTIF_TITLE: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static NOTIF_BODY: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// The achievement's own picture, when the download already landed: the card
/// paints it inside the medallion instead of the trophy glyph.
static NOTIF_ICON: Mutex<Option<Vec<u16>>> = Mutex::new(None);
/// The card stays until this epoch-ms timestamp.
static NOTIF_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Bumped per card; a stale animation thread must not hide a newer one.
static NOTIF_GEN: AtomicU64 = AtomicU64::new(0);

/// console-like notification card: icon disc, bold title, muted body line.
const NOTIF_HEIGHT: i32 = 116;
const NOTIF_MARGIN: i32 = 24;
const NOTIF_RADIUS: i32 = 12;
const NOTIF_ALPHA: u8 = 242;
static NOTIF_HOLD_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(5200);
/// 0 top-right, 1 top-left, 2 bottom-right, 3 bottom-left, 4 center-top,
/// 5 center-bottom.
static NOTIF_POSITION: AtomicU8 = AtomicU8::new(0);
/// Animation style preset: 0 = prism (unfurl), 1 = cyber (chamfer + scanline),
/// 2 = shatter (god-rays + diamond shards), 3 = jackpot (rainbow foil + shake),
/// 4 = xbox (pill capsule unroll), 5 = playstation (sleek edge glide + prism sweep),
/// 6 = epic (dimensional portal unfold).
static NOTIF_STYLE: AtomicU8 = AtomicU8::new(0);
/// Exit animation preset: 0 = auto (matches opening style), 1 = collapse (Xbox pill),
/// 2 = glide (PS5 edge slide), 3 = fold (Epic vertical fold), 4 = laser (Cyber beam),
/// 5 = implode (Shatter inward pull), 6 = zoom (Jackpot drop).
static NOTIF_EXIT_STYLE: AtomicU8 = AtomicU8::new(0);
/// Rarity tier: 0 = bronze/normal, 1 = silver, 2 = gold, 3 = ultra-rare diamond, 4 = platinum.
static NOTIF_RARITY_TIER: AtomicU8 = AtomicU8::new(2);
/// Completion ratio in permille (0..=1000) for the animated bottom progress bar.
static NOTIF_PROGRESS_PERMILLE: AtomicU64 = AtomicU64::new(650);
/// Elapsed milliseconds since the active card started, updated at 60 FPS.
static NOTIF_FRAME_MS: AtomicU64 = AtomicU64::new(0);
/// Target full card width so the renderer knows the unfurl ratio while morphing.
static NOTIF_FULL_W: AtomicIsize = AtomicIsize::new(540);
/// Current visible card width during horizontal capsule unroll/collapse morphing.
static NOTIF_CUR_W: AtomicIsize = AtomicIsize::new(540);

/// Packs CSS `(r, g, b)` channels into Windows `COLORREF` (`0x00BBGGRR`) order.
const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// Palette the achievement card paints with, in Windows `COLORREF` order
/// (`0x00BBGGRR`). The frontend supplies the launcher-theme values because the
/// CSS tokens live there; gold is the built-in default.
#[derive(Clone, Copy)]
pub struct AchievementCardColors {
    pub background: u32,
    pub accent: u32,
    pub border: u32,
    pub icon: u32,
    pub title: u32,
    pub body: u32,
}

pub const GOLD_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: rgb(0x0D, 0x0F, 0x14),
    accent: rgb(0xF5, 0x9E, 0x0B),
    border: rgb(0x78, 0x50, 0x18),
    icon: rgb(0xFB, 0xBF, 0x24),
    title: rgb(0xFF, 0xFF, 0xFF),
    body: rgb(0xAC, 0xB2, 0xB8),
};

pub const CYBER_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: rgb(0x09, 0x0B, 0x16),
    accent: rgb(0x00, 0xF0, 0xFF),
    border: rgb(0x0E, 0x74, 0x90),
    icon: rgb(0x38, 0xBD, 0xF8),
    title: rgb(0xF8, 0xFA, 0xFC),
    body: rgb(0x94, 0xA3, 0xB8),
};

pub const EMERALD_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: rgb(0x08, 0x12, 0x0E),
    accent: rgb(0x10, 0xB9, 0x81),
    border: rgb(0x04, 0x78, 0x57),
    icon: rgb(0x34, 0xD3, 0x99),
    title: rgb(0xF8, 0xFA, 0xFC),
    body: rgb(0xA7, 0xF3, 0xD0),
};

pub const CRIMSON_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: rgb(0x13, 0x09, 0x0C),
    accent: rgb(0xF4, 0x3F, 0x5E),
    border: rgb(0xBE, 0x12, 0x3C),
    icon: rgb(0xFB, 0x71, 0x85),
    title: rgb(0xFF, 0xF1, 0xF2),
    body: rgb(0xFD, 0xA4, 0xAF),
};

pub const AMETHYST_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: rgb(0x0F, 0x09, 0x18),
    accent: rgb(0xA8, 0x55, 0xF7),
    border: rgb(0x6B, 0x21, 0xA8),
    icon: rgb(0xC0, 0x84, 0xFC),
    title: rgb(0xFA, 0xF5, 0xFF),
    body: rgb(0xD8, 0xB4, 0xFE),
};

/// Returns a rarity-driven palette for `tier` (0 bronze .. 4 platinum),
/// matching `rarityCardPalette` in `src/core/achievement-card-theme.ts`.
pub fn rarity_card_colors(tier: u8) -> AchievementCardColors {
    match tier {
        0 => AchievementCardColors {
            background: rgb(0x11, 0x0D, 0x0B),
            accent: rgb(0xCD, 0x7F, 0x32),
            border: rgb(0x7C, 0x47, 0x1C),
            icon: rgb(0xE0, 0x9F, 0x5A),
            title: rgb(0xFF, 0xFF, 0xFF),
            body: rgb(0xCB, 0xB8, 0xA8),
        },
        1 => AchievementCardColors {
            background: rgb(0x0D, 0x10, 0x15),
            accent: rgb(0x94, 0xA3, 0xB8),
            border: rgb(0x47, 0x55, 0x69),
            icon: rgb(0xE2, 0xE8, 0xF0),
            title: rgb(0xFF, 0xFF, 0xFF),
            body: rgb(0xCB, 0xD5, 0xE1),
        },
        3 => AchievementCardColors {
            background: rgb(0x08, 0x10, 0x1D),
            accent: rgb(0x22, 0xD3, 0xEE),
            border: rgb(0x02, 0x84, 0xC7),
            icon: rgb(0x67, 0xE8, 0xF9),
            title: rgb(0xF0, 0xF9, 0xFF),
            body: rgb(0xBA, 0xE6, 0xFD),
        },
        4 => AchievementCardColors {
            background: rgb(0x11, 0x0C, 0x1D),
            accent: rgb(0xE8, 0x79, 0xF9),
            border: rgb(0x93, 0x33, 0xEA),
            icon: rgb(0xF5, 0xD0, 0xFE),
            title: rgb(0xFF, 0xFF, 0xFF),
            body: rgb(0xF3, 0xE8, 0xFF),
        },
        _ => GOLD_ACHIEVEMENT_CARD,
    }
}

/// The palette of the card currently on screen; a fresh card sets it before it
/// is shown, so the animation thread paints the right one.
static NOTIF_COLORS: Mutex<AchievementCardColors> = Mutex::new(GOLD_ACHIEVEMENT_CARD);

fn notification_is_left(position: u8) -> bool {
    position == 1 || position == 3
}

fn notification_is_center(position: u8) -> bool {
    position == 4 || position == 5
}

fn notification_is_bottom(position: u8) -> bool {
    position == 2 || position == 3 || position == 5
}

/// Card rect in the requested monitor corner. Pure math, unit-tested.
fn notif_rect(
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    position: u8,
    title_px: i32,
    body_px: i32,
) -> (i32, i32, i32, i32) {
    let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2);
    let m = size_metrics(size_code);
    let card_height = m.height;
    let max_width = (mon_w as i32 - 2 * NOTIF_MARGIN).max(m.min_width);
    let text_width = title_px.max(body_px).max(1);
    let style = NOTIF_STYLE.load(Ordering::Relaxed);
    let (t_left, t_right, min_w) = if style == 4 {
        // Generous spacing for capsule style (Xbox stadium pill):
        // comfortable padding between medallion and text, and ample margin before the right rounded cap
        let pad_l = (card_height / 2) + m.medallion_r + 26;
        let pad_r = (card_height / 2) + 24;
        let min_w = (m.min_width + 80).min(max_width);
        (pad_l, pad_r, min_w)
    } else {
        (m.text_left, m.text_right, m.min_width)
    };
    let width = (t_left + t_right + text_width).clamp(min_w, max_width);
    let x = if notification_is_left(position) {
        mon_x + NOTIF_MARGIN
    } else if notification_is_center(position) {
        mon_x + (mon_w as i32 - width) / 2
    } else {
        mon_x + mon_w as i32 - width - NOTIF_MARGIN
    };
    let y = if notification_is_bottom(position) {
        mon_y + mon_h as i32 - card_height - NOTIF_MARGIN
    } else {
        mon_y + NOTIF_MARGIN
    };
    (x, y, width, card_height)
}

fn text_px(units: &[u16], size: i32) -> i32 {
    units
        .iter()
        .map(|&unit| if unit >= 0x2E80 { size } else { size * 11 / 20 })
        .sum()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True while the notification card owns the plate; the metrics HUD must not
/// overwrite it.
pub fn hint_active() -> bool {
    NOTIF_ON.load(Ordering::Relaxed)
}

/// How long the next notification card stays on screen.
pub fn set_notification_hold(ms: u64) {
    NOTIF_HOLD_MS.store(ms.clamp(2000, 15_000), Ordering::Relaxed);
}

/// Which corner the next notification card uses.

pub struct NotifSizeMetrics {
    pub height: i32,
    pub min_width: i32,
    pub bar_width: i32,
    pub medallion_r: i32,
    pub left_pad: i32,
    pub text_left: i32,
    pub text_right: i32,
    pub tag_px: i32,
    pub title_px: i32,
    pub body_px: i32,
    pub tag_top: i32,
    pub tag_bottom: i32,
    pub title_top: i32,
    pub title_bottom: i32,
    pub body_top: i32,
    pub body_bottom: i32,
    pub icon_size: i32,
}

pub fn size_metrics(code: u8) -> NotifSizeMetrics {
    match code {
        0 => NotifSizeMetrics { // Küçük (matches CSS size-small)
            height: 94,
            min_width: 440,
            bar_width: 5,
            medallion_r: 22,
            left_pad: 18,
            text_left: 78,
            text_right: 20,
            tag_px: 11,
            title_px: 18,
            body_px: 13,
            tag_top: 13,
            tag_bottom: 29,
            title_top: 30,
            title_bottom: 58,
            body_top: 59,
            body_bottom: 84,
            icon_size: 20,
        },
        2 => NotifSizeMetrics { // Büyük (matches CSS size-large)
            height: 144,
            min_width: 600,
            bar_width: 8,
            medallion_r: 33,
            left_pad: 26,
            text_left: 112,
            text_right: 28,
            tag_px: 15,
            title_px: 27,
            body_px: 18,
            tag_top: 17,
            tag_bottom: 41,
            title_top: 43,
            title_bottom: 84,
            body_top: 86,
            body_bottom: 126,
            icon_size: 30,
        },
        _ => NotifSizeMetrics { // 1 = Normal (Standard, matches CSS size-normal)
            height: NOTIF_HEIGHT,
            min_width: 520,
            bar_width: 6,
            medallion_r: 27,
            left_pad: 22,
            text_left: 92,
            text_right: 24,
            tag_px: 13,
            title_px: 22,
            body_px: 15,
            tag_top: 15,
            tag_bottom: 35,
            title_top: 36,
            title_bottom: 69,
            body_top: 70,
            body_bottom: 101,
            icon_size: 24,
        },
    }
}

pub fn set_notification_size(size: &str) {
    let code = match size {
        "small" | "compact" => 0,
        "large" => 2,
        _ => 1,
    };
    NOTIF_SIZE.store(code, Ordering::Relaxed);
}

pub fn set_notification_position(position: &str) {
    let code = match position {
        "top-left" => 1,
        "bottom-right" => 2,
        "bottom-left" => 3,
        "center-top" => 4,
        "center-bottom" => 5,
        _ => 0,
    };
    NOTIF_POSITION.store(code, Ordering::Relaxed);
}

pub fn set_notification_style(style: &str) {
    let code = match style {
        "cyber" => 1,
        "shatter" => 2,
        "jackpot" => 3,
        "xbox" => 4,
        "playstation" => 5,
        "epic" => 6,
        _ => 0,
    };
    NOTIF_STYLE.store(code, Ordering::Relaxed);
}

pub fn set_notification_exit_style(style: &str) {
    let code = match style {
        "collapse" => 1,
        "glide" => 2,
        "fold" => 3,
        "laser" => 4,
        "implode" => 5,
        "zoom" => 6,
        _ => 0,
    };
    NOTIF_EXIT_STYLE.store(code, Ordering::Relaxed);
}

pub fn set_notification_rarity_tier(tier: u8) {
    NOTIF_RARITY_TIER.store(tier.min(4), Ordering::Relaxed);
}

pub fn set_notification_progress(permille: u64) {
    NOTIF_PROGRESS_PERMILLE.store(permille.min(1000), Ordering::Relaxed);
}

/// Shows a console-like system notification over the game (game start: the overlay
/// hint). Reuses the HUD window: a Windows toast is invisible for many setups,
/// this card is not. `title` is the bold line, `body` the muted one.
pub fn notify(title: &str, body: &str) {
    if let Some((tag, rest)) = title.split_once(": ") {
        notify_ext(&tag.to_uppercase(), rest, body);
    } else if let Some(stripped) = title.strip_prefix("🏆 ") {
        notify_ext("BAŞARIM KAZANILDI", stripped, body);
    } else {
        notify_ext("", title, body);
    }
}

/// Explicit notification showing tag line (accent uppercase), title (bold), and body (muted).
pub fn notify_ext(tag: &str, title: &str, body: &str) {
    notify_card(tag, title, body, GOLD_ACHIEVEMENT_CARD);
}

/// Achievement cards can follow the launcher theme instead of the gold card;
/// the palette is passed in so a later hint keeps its own colours. The returned
/// generation lets a late icon fetch paint the card that is still on screen.
pub fn notify_achievement(
    tag: &str,
    title: &str,
    body: &str,
    colors: AchievementCardColors,
) -> u64 {
    notify_card(tag, title, body, colors)
}

/// Puts a downloaded achievement icon on the card `generation` named. A stale
/// generation (a newer card is already up) is ignored.
pub fn set_notification_icon(generation: u64, path: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if generation == 0
            || NOTIF_GEN.load(Ordering::Relaxed) != generation
            || !NOTIF_ON.load(Ordering::Relaxed)
        {
            return;
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        if let Ok(mut slot) = NOTIF_ICON.lock() {
            *slot = Some(wide);
        }
        let hwnd = HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            unsafe {
                InvalidateRect(hwnd, std::ptr::null(), 0);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (generation, path);
    }
}

fn notify_card(tag: &str, title: &str, body: &str, colors: AchievementCardColors) -> u64 {
    #[cfg(windows)]
    {
        if let Ok(mut slot) = NOTIF_COLORS.lock() {
            *slot = colors;
        }
        // A new card never inherits the previous achievement's picture.
        if let Ok(mut slot) = NOTIF_ICON.lock() {
            *slot = None;
        }
        ensure_window();
        {
            let mut wide_tag = tag.encode_utf16().collect::<Vec<u16>>();
            wide_tag.push(0);
            if let Ok(mut slot) = NOTIF_TAG.lock() {
                *slot = wide_tag;
            }
            let mut wide_title = title.encode_utf16().collect::<Vec<u16>>();
            wide_title.push(0);
            if let Ok(mut slot) = NOTIF_TITLE.lock() {
                *slot = wide_title;
            }
            let mut wide_body = body.encode_utf16().collect::<Vec<u16>>();
            wide_body.push(0);
            if let Ok(mut slot) = NOTIF_BODY.lock() {
                *slot = wide_body;
            }
        }
        let start_ms = now_ms();
        let hold_ms = NOTIF_HOLD_MS.load(Ordering::Relaxed);
        NOTIF_FRAME_MS.store(0, Ordering::Relaxed);
        NOTIF_ON.store(true, Ordering::SeqCst);
        NOTIF_UNTIL.store(start_ms + hold_ms, Ordering::Relaxed);
        let generation = NOTIF_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let hwnd = HWND.load(Ordering::SeqCst);
        if hwnd == 0 {
            return generation;
        }

        let (mon_x, mon_y, mon_w, mon_h) =
            monitor_rect_for(foreground_window()).unwrap_or((0, 0, 1920, 1080));
        let position = NOTIF_POSITION.load(Ordering::Relaxed);
        let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2);
        let m = size_metrics(size_code);
        let tag_px = if tag.is_empty() { 0 } else { text_px(&tag.encode_utf16().collect::<Vec<u16>>(), m.tag_px) };
        let title_px = text_px(&title.encode_utf16().collect::<Vec<u16>>(), m.title_px).max(tag_px);
        let body_px = text_px(&body.encode_utf16().collect::<Vec<u16>>(), m.body_px);
        let (x, y, w, h) = notif_rect(mon_x, mon_y, mon_w, mon_h, position, title_px, body_px);
        NOTIF_FULL_W.store(w as isize, Ordering::Relaxed);
        NOTIF_CUR_W.store(w as isize, Ordering::Relaxed);

        let init_y = if notification_is_bottom(position) { y + 22 } else { y - 22 };

        unsafe {
            shape_notification_morphed(hwnd, 0, 0, w, h, NOTIF_STYLE.load(Ordering::Relaxed));
            MoveWindow(hwnd, x, init_y, w, h, 1);
            set_alpha(hwnd, 0);
            ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }

        std::thread::spawn(move || {
            run_dopamine_choreography(hwnd, generation, start_ms, x, y, w, h, position);
            if NOTIF_GEN.load(Ordering::Relaxed) == generation {
                NOTIF_ON.store(false, Ordering::SeqCst);
                hide_window();
            }
        });
        generation
    }
    #[cfg(not(windows))]
    {
        let _ = (tag, title, body, colors);
        0
    }
}

/// 60 FPS choreography:
/// 1. Distinct console/arcade entry choreography per `style` (`0..=6`: Prism, Cyber, Shatter, Jackpot, Xbox, PlayStation, Epic)
/// 2. Live 32-bit DIB shockwaves, god-rays, shimmer, progress bar & particle burst
/// 3. Distinct closing choreography (`0..=6`: Auto, Collapse, Glide, Fold, Laser, Implode, Zoom) at `until`
#[cfg(windows)]
fn run_dopamine_choreography(
    hwnd: isize,
    generation: u64,
    start_ms: u64,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    position: u8,
) {
    let style = NOTIF_STYLE.load(Ordering::Relaxed);
    let exit_raw = NOTIF_EXIT_STYLE.load(Ordering::Relaxed);
    let exit_code = if exit_raw == 0 {
        match style {
            4 | 0 => 1, // Xbox / Prism -> Capsule Collapse
            5 => 2,     // PlayStation -> Edge Glide
            6 => 3,     // Epic -> Dimensional Fold
            1 => 4,     // Cyber -> Laser Beam Collapse
            2 => 5,     // Shatter -> Crystal Implode
            3 => 6,     // Jackpot -> Rocket Zoom
            _ => 1,
        }
    } else {
        exit_raw
    };
    let tier = NOTIF_RARITY_TIER.load(Ordering::Relaxed);
    let pill_min_w = h.min(w);
    let is_left = notification_is_left(position);
    let is_center = notification_is_center(position);
    let is_bottom = notification_is_bottom(position);
    let mut last_x = x;
    let mut last_y = if is_bottom { y + 22 } else { y - 22 };
    let mut last_alpha = 0u8;
    let mut last_clip = (0i32, 0i32, w, h);

    loop {
        if NOTIF_GEN.load(Ordering::Relaxed) != generation || !hint_active() {
            return;
        }
        let now = now_ms();
        let until = NOTIF_UNTIL.load(Ordering::Relaxed);
        let exit_ms = 380u64;
        if now >= until + exit_ms {
            break;
        }
        let elapsed = now.saturating_sub(start_ms);
        NOTIF_FRAME_MS.store(elapsed, Ordering::Relaxed);

        let clip_l = 0;
        let clip_t = 0;
        let mut clip_r = w;
        let clip_b = h;

        let (dx, dy, alpha) = if now >= until {
            let t = ((now - until) as f32 / exit_ms as f32).clamp(0.0, 1.0);
            match exit_code {
                1 => {
                    // 1: Xbox Capsule Collapse — rolls horizontally back into the medallion pill, then pops out
                    if t < 0.72 {
                        let u = (t / 0.72).clamp(0.0, 1.0);
                        let ease = u * u * (3.0 - 2.0 * u);
                        clip_r = (w as f32 - (w - pill_min_w) as f32 * ease).round() as i32;
                        let shift = if is_left {
                            0
                        } else if is_center {
                            (w - clip_r) / 2
                        } else {
                            w - clip_r
                        };
                        (shift, 0, NOTIF_ALPHA)
                    } else {
                        clip_r = pill_min_w;
                        let u = ((t - 0.72) / 0.28).clamp(0.0, 1.0);
                        let shift = if is_left {
                            0
                        } else if is_center {
                            (w - pill_min_w) / 2
                        } else {
                            w - pill_min_w
                        };
                        let drop = ((18.0 * u * u) as i32) * if is_bottom { 1 } else { -1 };
                        let a = (NOTIF_ALPHA as f32 * (1.0 - u).powi(2)) as u8;
                        (shift, drop, a)
                    }
                }
                2 => {
                    // 2: PlayStation Edge Glide — sleek horizontal accelerate-out toward screen edge
                    let ease = t * t * t;
                    let horiz = if is_center {
                        0
                    } else {
                        let dist = (96.0 * ease) as i32;
                        if is_left { -dist } else { dist }
                    };
                    let vert = if is_center {
                        let dist = (38.0 * ease) as i32;
                        if is_bottom { dist } else { -dist }
                    } else {
                        0
                    };
                    let a = (NOTIF_ALPHA as f32 * (1.0 - t * t)) as u8;
                    (horiz, vert, a)
                }
                3 => {
                    // 3: Epic Dimensional Fold — dimensional lift + fade
                    let ease = t * t * t;
                    let slide = ((28.0 * ease) as i32) * if is_bottom { 1 } else { -1 };
                    let a = (NOTIF_ALPHA as f32 * (1.0 - ease)) as u8;
                    (0, slide, a)
                }
                4 => {
                    // 4: Laser Snap Exit — razor-fast snap away
                    let ease = t * t;
                    let snap = ((32.0 * ease) as i32) * if is_bottom { 1 } else { -1 };
                    let a = (NOTIF_ALPHA as f32 * (1.0 - ease)) as u8;
                    (0, snap, a)
                }
                5 => {
                    // 5: Crystal Shatter Implode — brief outward swell then rapid drop
                    if t < 0.25 {
                        let u = t / 0.25;
                        let swell = ((-8.0 * (u * std::f32::consts::PI).sin()) as i32)
                            * if is_bottom { 1 } else { -1 };
                        (0, swell, NOTIF_ALPHA)
                    } else {
                        let u = ((t - 0.25) / 0.75).clamp(0.0, 1.0);
                        let ease = u * u;
                        let drop = ((38.0 * ease) as i32) * if is_bottom { 1 } else { -1 };
                        let a = (NOTIF_ALPHA as f32 * (1.0 - ease)) as u8;
                        (0, drop, a)
                    }
                }
                _ => {
                    // 6: Jackpot Rocket Zoom — quick windup then fast launch
                    let windup = if t < 0.28 {
                        let u = t / 0.28;
                        (-10.0 * (u * std::f32::consts::FRAC_PI_2).sin()) as i32
                    } else {
                        let u = (t - 0.28) / 0.72;
                        (44.0 * u * u) as i32
                    };
                    let drop = if is_bottom { windup } else { -windup };
                    let a = (NOTIF_ALPHA as f32 * (1.0 - t.powi(2))) as u8;
                    (0, drop, a)
                }
            }
        } else {
            // Opening choreography per `style`
            match style {
                4 => {
                    // 4: Xbox Series Capsule Unroll (680ms)
                    // Phase 1 (0..220ms): Medallion circle pops in
                    // Phase 2 (220..680ms): Pill unrolls horizontally from `pill_min_w` to `w`
                    if elapsed < 220 {
                        clip_r = pill_min_w;
                        let u = (elapsed as f32 / 220.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv * inv * inv;
                        let pop = (((1.0 - ease) * 28.0).round() as i32)
                            * if is_bottom { 1 } else { -1 };
                        let shift = if is_left {
                            0
                        } else if is_center {
                            (w - pill_min_w) / 2
                        } else {
                            w - pill_min_w
                        };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 110.0).clamp(0.0, 1.0)) as u8;
                        (shift, pop, a)
                    } else if elapsed < 680 {
                        let u = ((elapsed - 220) as f32 / 460.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv * inv * inv * (1.0 - 0.25 * (u * std::f32::consts::PI).sin());
                        clip_r = (pill_min_w as f32 + (w - pill_min_w) as f32 * ease)
                            .round()
                            .clamp(pill_min_w as f32, w as f32) as i32;
                        let shift = if is_left {
                            0
                        } else if is_center {
                            (w - clip_r) / 2
                        } else {
                            w - clip_r
                        };
                        (shift, 0, NOTIF_ALPHA)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                5 => {
                    // 5: PlayStation 5 Trophy Glide (520ms) — long sleek horizontal slide from screen edge
                    if elapsed < 520 {
                        let u = (elapsed as f32 / 520.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv.powi(4);
                        let horiz = if is_center {
                            0
                        } else {
                            let side = ((1.0 - ease) * 110.0).round() as i32;
                            if is_left { -side } else { side }
                        };
                        let vert = if is_center {
                            let v = ((1.0 - ease) * 44.0).round() as i32;
                            if is_bottom { v } else { -v }
                        } else {
                            0
                        };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 180.0).clamp(0.0, 1.0)) as u8;
                        (horiz, vert, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                6 => {
                    // 6: Epic Games Portal Unfold (460ms) — crisp dimensional drop + rebound
                    if elapsed < 460 {
                        let u = (elapsed as f32 / 460.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv * inv * inv;
                        let drop = (((1.0 - ease) * 36.0).round() as i32)
                            * if is_bottom { 1 } else { -1 };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 120.0).clamp(0.0, 1.0)) as u8;
                        (0, drop, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                1 => {
                    // 1: Laser Slice (380ms) — rapid high-tech slide down with neon laser snap
                    if elapsed < 380 {
                        let u = (elapsed as f32 / 380.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv.powi(4);
                        let offset = (((1.0 - ease) * 28.0).round() as i32)
                            * if is_bottom { 1 } else { -1 };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 90.0).clamp(0.0, 1.0)) as u8;
                        (0, offset, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                2 => {
                    // 2: Crystal Shatter (420ms) — high-impact diagonal slam + rebound
                    if elapsed < 420 {
                        let u = (elapsed as f32 / 420.0).clamp(0.0, 1.0);
                        let bounce = if u < 0.62 {
                            let s = u / 0.62;
                            1.0 - s * s
                        } else {
                            let s = (u - 0.62) / 0.38;
                            -(s * std::f32::consts::PI).sin() * 0.18
                        };
                        let vert = ((bounce * 46.0).round() as i32) * if is_bottom { 1 } else { -1 };
                        let horiz = ((bounce * 22.0).round() as i32) * if is_left { -1 } else { 1 };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 110.0).clamp(0.0, 1.0)) as u8;
                        (horiz, vert, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                3 => {
                    // 3: Arcade Jackpot (460ms) — deep spring pop with overshoot
                    if elapsed < 460 {
                        let u = (elapsed as f32 / 460.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let spring = 1.0 - inv * inv * ((u * std::f32::consts::PI * 1.65).cos());
                        let offset = ((1.0 - spring) * 44.0).round() as i32;
                        let drop = if is_bottom { offset } else { -offset };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 110.0).clamp(0.0, 1.0)) as u8;
                        (0, drop, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
                _ => {
                    // 0: Prism Unfurl (500ms) — smooth vertical spring + capsule unroll
                    if elapsed < 500 {
                        let u = (elapsed as f32 / 500.0).clamp(0.0, 1.0);
                        let inv = 1.0 - u;
                        let ease = 1.0 - inv * inv * inv * (1.0 - 0.35 * (u * std::f32::consts::PI).sin());
                        let offset = ((1.0 - ease) * 32.0).round() as i32;
                        let drop = if is_bottom { offset } else { -offset };
                        let w_ease = ((elapsed as f32 / 380.0).clamp(0.0, 1.0)).powf(0.65);
                        clip_r = (pill_min_w as f32 + (w - pill_min_w) as f32 * w_ease)
                            .round()
                            .clamp(pill_min_w as f32, w as f32) as i32;
                        let shift = if is_left {
                            0
                        } else if is_center {
                            (w - clip_r) / 2
                        } else {
                            w - clip_r
                        };
                        let a = (NOTIF_ALPHA as f32 * (elapsed as f32 / 130.0).clamp(0.0, 1.0)) as u8;
                        (shift, drop, a)
                    } else {
                        (0, 0, NOTIF_ALPHA)
                    }
                }
            }
        };

        // Impact micro-shake for Arcade Jackpot style, Shatter slam, or Ultra-Rare/Platinum unlocks
        let (shake_x, shake_y) = if (style == 3 || style == 2 || tier >= 3) && elapsed >= 65 && elapsed <= 290 {
            let damp = 1.0 - ((elapsed - 65) as f32 / 225.0);
            let amp = if style == 3 { 5.5 } else { 3.5 };
            let sx = ((elapsed as f32 * 0.14).sin() * amp * damp) as i32;
            let sy = ((elapsed as f32 * 0.20).cos() * (amp * 0.65) * damp) as i32;
            (sx, sy)
        } else {
            (0, 0)
        };

        let cur_x = x + dx + shake_x;
        let cur_y = y + dy + shake_y;
        let cur_clip = (clip_l, clip_t, clip_r, clip_b);
        NOTIF_CUR_W.store(clip_r as isize, Ordering::Relaxed);

        unsafe {
            if cur_clip != last_clip {
                shape_notification_morphed(hwnd, clip_l, clip_t, clip_r, clip_b, style);
                last_clip = cur_clip;
            }
            if cur_x != last_x || cur_y != last_y {
                MoveWindow(hwnd, cur_x, cur_y, w, h, 0);
                last_x = cur_x;
                last_y = cur_y;
            }
            if alpha != last_alpha {
                set_alpha(hwnd, alpha);
                last_alpha = alpha;
            }
            InvalidateRect(hwnd, std::ptr::null(), 0);
            UpdateWindow(hwnd);
        }

        std::thread::sleep(std::time::Duration::from_millis(16));
    }
}

/// Cuts the current HUD line into a UTF-16 buffer for GDI.
#[cfg(windows)]
pub fn update(text: &str) {
    // A notification owns the plate; the metrics tick restores the HUD after it.
    if hint_active() {
        return;
    }
    ensure_window();
    {
        let mut wide = text.encode_utf16().collect::<Vec<u16>>();
        wide.push(0);
        if let Ok(mut slot) = TEXT.lock() {
            *slot = wide;
        }
    }
    let hwnd = HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return;
    }
    let (top_x, top_y) = monitor_top_left();
    let w = ((text.chars().count() as i32) * 8 + 28).max(240);
    unsafe {
        reset_shape(hwnd);
        MoveWindow(hwnd, top_x + 16, top_y + 16, w, 30, 1);
        set_alpha(hwnd, 215);
        ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
        InvalidateRect(hwnd, std::ptr::null(), 0);
    }
}

#[cfg(not(windows))]
pub fn update(_text: &str) {}

pub fn hide() {
    // The notification keeps the plate until its slide-out finishes.
    if hint_active() {
        return;
    }
    hide_window();
}

fn hide_window() {
    #[cfg(windows)]
    {
        let hwnd = HWND.load(Ordering::Relaxed);
        if hwnd != 0 {
            unsafe {
                ShowWindow(hwnd, 0); // SW_HIDE
            }
        }
    }
}

/// Layers the window into the rounded, pill-shaped, or chamfered card region;
/// supports live horizontal/vertical morphing during opening and closing animations.
#[cfg(windows)]
unsafe fn shape_notification_morphed(
    hwnd: isize,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    style: u8,
) {
    let w = (right - left).max(4);
    let h = (bottom - top).max(4);
    let region = if style == 4 {
        // True Stadium Capsule (Xbox): full stadium pill (corner diameter = height)
        let diameter = h.min(w);
        CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter)
    } else if style == 1 {
        // Laser Slice: sharp 8px tech corners
        let diameter = 16.min(h).min(w);
        CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter)
    } else if style == 6 {
        // Dimensional Fold (Epic): 10px corners
        let diameter = 20.min(h).min(w);
        CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter)
    } else if style == 5 {
        // PlayStation: 18px sleek corners
        let diameter = 36.min(h).min(w);
        CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter)
    } else {
        let diameter = (NOTIF_RADIUS * 2).min(h).min(w);
        CreateRoundRectRgn(left, top, right + 1, bottom + 1, diameter, diameter)
    };
    if region != 0 {
        SetWindowRgn(hwnd, region, 1);
    }
}

/// Back to a plain rectangle for the HUD strip.
#[cfg(windows)]
unsafe fn reset_shape(hwnd: isize) {
    SetWindowRgn(hwnd, 0, 1);
}

#[cfg(windows)]
unsafe fn set_alpha(hwnd: isize, alpha: u8) {
    SetLayeredWindowAttributes(hwnd, 0, alpha, 0x0000_0002 /* LWA_ALPHA */);
}

/* ---------- Window helpers (used by the overlay panel too) ---------- */

/// The window in front of everything right now.
pub fn foreground_window() -> isize {
    #[cfg(windows)]
    unsafe {
        return GetForegroundWindow();
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Brings a window back to the front (focus restore when the panel closes).
pub fn focus_window(hwnd: isize) {
    #[cfg(windows)]
    if hwnd != 0 {
        unsafe {
            SetForegroundWindow(hwnd as *mut core::ffi::c_void);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
    }
}

/// True while `hwnd` still names a live, visible window. The overlay panel
/// follows its game window with this: the running-game watch can flap for
/// titles the launcher did not start, and that must not close the panel.
pub fn window_alive(hwnd: isize) -> bool {
    #[cfg(windows)]
    unsafe {
        if hwnd == 0 {
            return false;
        }
        IsWindow(hwnd) != 0 && IsWindowVisible(hwnd) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        false
    }
}

/// Retrieves the visible window title text (for detecting games run outside the launcher).
pub fn window_title(hwnd: isize) -> String {
    #[cfg(windows)]
    if hwnd != 0 {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), 512) };
        if len > 0 {
            return String::from_utf16_lossy(&buf[..len as usize]);
        }
    }
    #[cfg(not(windows))]
    let _ = hwnd;
    String::new()
}

/// Largest visible top-level window that belongs to one of `pids` (0 = none).
/// Used to (re)find the game window when a fullscreen switch recreates it.
pub fn find_game_window(pids: &[u32]) -> isize {
    #[cfg(windows)]
    unsafe {
        struct Find<'a> {
            pids: &'a [u32],
            best: isize,
            best_area: i64,
        }
        unsafe extern "system" fn callback(hwnd: isize, lparam: isize) -> i32 {
            let state = &mut *(lparam as *mut Find);
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if !state.pids.contains(&pid) {
                return 1;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return 1;
            }
            let area =
                (rect.right - rect.left).max(0) as i64 * (rect.bottom - rect.top).max(0) as i64;
            if area > state.best_area {
                state.best_area = area;
                state.best = hwnd;
            }
            1
        }
        if pids.is_empty() {
            return 0;
        }
        let mut state = Find {
            pids,
            best: 0,
            best_area: 0,
        };
        let _ = EnumWindows(Some(callback), &mut state as *mut Find as isize);
        state.best
    }
    #[cfg(not(windows))]
    {
        let _ = pids;
        0
    }
}

/// Full monitor rectangle (x, y, width, height) that hosts `hwnd`, or the
/// monitor under the cursor when no window is known.
pub fn monitor_rect_for(hwnd: isize) -> Option<(i32, i32, u32, u32)> {
    #[cfg(windows)]
    {
        unsafe {
            let monitor = if hwnd != 0 {
                MonitorFromWindow(hwnd, 2) // MONITOR_DEFAULTTONEAREST
            } else {
                MonitorFromPoint(POINT { x: 0, y: 0 }, 2)
            };
            if monitor == 0 {
                return None;
            }
            let mut info = MONITORINFO {
                cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                rc_monitor: RECT::default(),
                rc_work: RECT::default(),
                flags: 0,
            };
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            let r = info.rc_monitor;
            return Some((
                r.left,
                r.top,
                (r.right - r.left).max(320) as u32,
                (r.bottom - r.top).max(240) as u32,
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
}

#[cfg(windows)]
fn monitor_top_left() -> (i32, i32) {
    monitor_rect_for(foreground_window())
        .map(|(x, y, _, _)| (x, y))
        .unwrap_or((0, 0))
}

/* ---------- Win32 plumbing ---------- */

#[cfg(windows)]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct MONITORINFO {
    cb_size: u32,
    rc_monitor: RECT,
    rc_work: RECT,
    flags: u32,
}

#[cfg(windows)]
#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}

#[cfg(windows)]
#[repr(C)]
struct WNDCLASSW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> isize;
    // Same signature as the declaration in main.rs so the two agree.
    fn SetForegroundWindow(hwnd: *mut core::ffi::c_void) -> i32;
    pub fn SetWindowPos(
        hwnd: *mut core::ffi::c_void,
        hwnd_insert_after: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    pub fn GetWindowTextW(hwnd: isize, lp_string: *mut u16, n_max_count: i32) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn EnumWindows(
        callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
        lparam: isize,
    ) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetWindowRect(hwnd: isize, rect: *mut RECT) -> i32;
    fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
    fn MonitorFromPoint(pt: POINT, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MONITORINFO) -> i32;
    fn RegisterClassW(class: *const WNDCLASSW) -> u16;
    /// Rounds the layered window; the OS takes ownership of the region.
    fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: isize,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn MoveWindow(hwnd: isize, x: i32, y: i32, width: i32, height: i32, repaint: i32) -> i32;
    fn InvalidateRect(hwnd: isize, rect: *const RECT, erase: i32) -> i32;
    fn UpdateWindow(hwnd: isize) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut RECT) -> i32;
    fn BeginPaint(hwnd: isize, paint: *mut u8) -> isize;
    fn EndPaint(hwnd: isize, paint: *const u8) -> i32;
    fn GetMessageW(msg: *mut u8, hwnd: isize, min: u32, max: u32) -> i32;
    fn TranslateMessage(msg: *const u8) -> i32;
    fn DispatchMessageW(msg: *const u8) -> isize;
    fn PostQuitMessage(code: i32);
    fn FillRect(hdc: isize, rect: *const RECT, brush: isize);
    fn DrawTextW(hdc: isize, text: *const u16, count: i32, rect: *mut RECT, format: u32) -> i32;
    fn SetBkMode(hdc: isize, mode: i32) -> i32;
    fn SetTextColor(hdc: isize, color: u32) -> u32;
    fn SelectObject(hdc: isize, object: isize) -> isize;
}

#[cfg(windows)]
#[repr(C)]
struct BITMAPINFOHEADER {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[cfg(windows)]
#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(color: u32) -> isize;
    fn DeleteObject(object: isize) -> i32;
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn CreateDIBSection(
        hdc: isize,
        pbmi: *const BITMAPINFOHEADER,
        usage: u32,
        ppv_bits: *mut *mut u32,
        h_section: isize,
        offset: u32,
    ) -> isize;
    fn BitBlt(
        hdc_dest: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        hdc_src: isize,
        x1: i32,
        y1: i32,
        rop: u32,
    ) -> i32;
    /// Region for the rounded notification card (`x2`/`y2` are exclusive).
    fn CreateRoundRectRgn(
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
        ellipse_w: i32,
        ellipse_h: i32,
    ) -> isize;
    #[allow(dead_code)]
    fn CreatePolygonRgn(pptl: *const POINT, c_point: i32, i_mode: i32) -> isize;
    #[allow(dead_code)]
    fn FrameRgn(hdc: isize, region: isize, brush: isize, width: i32, height: i32) -> i32;
    fn CreateEllipticRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strike_out: u32,
        charset: u32,
        out_precision: u32,
        clip_precision: u32,
        quality: u32,
        pitch_and_family: u32,
        face: *const u16,
    ) -> isize;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[cfg(windows)]
#[repr(C)]
struct GdiplusStartupInput {
    gdiplus_version: u32,
    debug_event_callback: usize,
    suppress_background_thread: i32,
    suppress_external_codecs: i32,
}

#[cfg(windows)]
#[link(name = "gdiplus")]
extern "system" {
    fn GdiplusStartup(
        token: *mut usize,
        input: *const GdiplusStartupInput,
        output: *mut core::ffi::c_void,
    ) -> i32;
    fn GdipCreateFromHDC(hdc: isize, graphics: *mut *mut core::ffi::c_void) -> i32;
    fn GdipLoadImageFromFile(
        filename: *const u16,
        image: *mut *mut core::ffi::c_void,
    ) -> i32;
    fn GdipDrawImageRectI(
        graphics: *mut core::ffi::c_void,
        image: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> i32;
    fn GdipSetClipHrgn(
        graphics: *mut core::ffi::c_void,
        region: isize,
        combine_mode: i32,
    ) -> i32;
    fn GdipResetClip(graphics: *mut core::ffi::c_void) -> i32;
    fn GdipDeleteGraphics(graphics: *mut core::ffi::c_void) -> i32;
    fn GdipDisposeImage(image: *mut core::ffi::c_void) -> i32;
}

/// GDI+ is started once for the process; the codec providers stay loaded. The
/// screenshot module does the same for its encoder, and neither ever shuts it
/// down because the app is long-lived.
#[cfg(windows)]
static GDIPLUS_READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg(windows)]
fn ensure_gdiplus() -> bool {
    *GDIPLUS_READY.get_or_init(|| unsafe {
        let input = GdiplusStartupInput {
            gdiplus_version: 1,
            debug_event_callback: 0,
            suppress_background_thread: 0,
            suppress_external_codecs: 0,
        };
        let mut token: usize = 0;
        GdiplusStartup(&mut token, &input, std::ptr::null_mut()) == 0
    })
}

#[cfg(windows)]
const WS_POPUP: u32 = 0x8000_0000;
#[cfg(windows)]
const WS_EX_TOPMOST: u32 = 0x0000_0008;
#[cfg(windows)]
const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
#[cfg(windows)]
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
#[cfg(windows)]
const WS_EX_LAYERED: u32 = 0x0008_0000;
#[cfg(windows)]
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
#[cfg(windows)]
const WM_PAINT: u32 = 0x000F;
#[cfg(windows)]
const WM_ERASEBKGND: u32 = 0x0014;
#[cfg(windows)]
const WM_NCHITTEST: u32 = 0x0084;
#[cfg(windows)]
const WM_DESTROY: u32 = 0x0002;
#[cfg(windows)]
const HTTRANSPARENT: isize = -1;
#[cfg(windows)]
const DT_LEFT: u32 = 0x0000;
#[cfg(windows)]
const DT_VCENTER: u32 = 0x0004;
#[cfg(windows)]
const DT_SINGLELINE: u32 = 0x0020;
#[cfg(windows)]
const DT_NOPREFIX: u32 = 0x0800;
#[cfg(windows)]
const DT_END_ELLIPSIS: u32 = 0x8000;
#[cfg(windows)]
const TRANSPARENT_BK: i32 = 1;

/// Notification title/body: one line, no mnemonic parsing, ellipsis on overflow.
#[cfg(windows)]
const NOTIF_TEXT_FORMAT: u32 = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;

#[cfg(windows)]
unsafe extern "system" fn hud_wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_PAINT => {
            let mut paint = [0u8; 128];
            let hdc = BeginPaint(hwnd, paint.as_mut_ptr());
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect);
            if hint_active() {
                paint_notification(hdc, &rect);
            } else {
                paint_hud(hdc, &rect);
            }
            EndPaint(hwnd, paint.as_ptr());
            0
        }
        WM_ERASEBKGND => 1,
        WM_NCHITTEST => HTTRANSPARENT,
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// The always-on metrics strip: one line on a dark plate.
#[cfg(windows)]
unsafe fn paint_hud(hdc: isize, rect: &RECT) {
    let brush = CreateSolidBrush(0x000E0E12); // COLORREF 0x00BBGGRR
    FillRect(hdc, rect, brush);
    let _ = DeleteObject(brush);
    let font = FONT.load(Ordering::Relaxed);
    if font != 0 {
        SelectObject(hdc, font);
    }
    SetBkMode(hdc, TRANSPARENT_BK);
    SetTextColor(hdc, 0x00F2F2F2);
    if let Ok(text) = TEXT.lock() {
        if text.len() > 1 {
            let mut text_rect = RECT {
                left: 12,
                top: 0,
                right: rect.right - 12,
                bottom: rect.bottom,
            };
            DrawTextW(
                hdc,
                text.as_ptr(),
                (text.len() - 1) as i32,
                &mut text_rect,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE,
            );
        }
    }
}

/// Draws the achievement's own picture inside the medallion, clipped to the
/// disc. False when no picture landed yet, so the card keeps the trophy glyph.
#[cfg(windows)]
unsafe fn paint_medallion_picture(
    hdc: isize,
    center_x: i32,
    center_y: i32,
    radius: i32,
) -> bool {
    let file = match NOTIF_ICON.lock() {
        Ok(slot) => slot.clone(),
        Err(_) => None,
    };
    let Some(file) = file else {
        return false;
    };
    if !ensure_gdiplus() {
        return false;
    }
    let mut graphics: *mut core::ffi::c_void = std::ptr::null_mut();
    if GdipCreateFromHDC(hdc, &mut graphics) != 0 || graphics.is_null() {
        return false;
    }
    let region = CreateEllipticRgn(
        center_x - radius,
        center_y - radius,
        center_x + radius + 1,
        center_y + radius + 1,
    );
    if region == 0 {
        GdipDeleteGraphics(graphics);
        return false;
    }
    // A square picture over a round medallion would break the card's shape, so
    // the draw is skipped when the round clip cannot be installed.
    let clipped = GdipSetClipHrgn(graphics, region, 0) == 0;
    let mut image: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut painted = false;
    if clipped && GdipLoadImageFromFile(file.as_ptr(), &mut image) == 0 && !image.is_null() {
        painted = GdipDrawImageRectI(
            graphics,
            image,
            center_x - radius,
            center_y - radius,
            radius * 2,
            radius * 2,
        ) == 0;
        GdipDisposeImage(image);
    }
    GdipResetClip(graphics);
    let _ = DeleteObject(region);
    GdipDeleteGraphics(graphics);
    painted
}

#[cfg(windows)]
#[inline]
fn colorref_rgb(c: u32) -> (f32, f32, f32) {
    (
        (c & 0xFF) as f32,
        ((c >> 8) & 0xFF) as f32,
        ((c >> 16) & 0xFF) as f32,
    )
}

#[cfg(windows)]
#[inline]
fn pack_dib(r: f32, g: f32, b: f32) -> u32 {
    let ri = (r.clamp(0.0, 255.0)) as u32;
    let gi = (g.clamp(0.0, 255.0)) as u32;
    let bi = (b.clamp(0.0, 255.0)) as u32;
    (ri << 16) | (gi << 8) | bi
}

/// Signed distance to a 2D trophy cup in normalized `[-1.2, 1.2]` coordinates.
/// Returns `< 0.0` inside the trophy silhouette and `> 0.0` outside.
#[cfg(windows)]
#[inline]
fn trophy_sdf(u: f32, v: f32) -> f32 {
    let ax = u.abs();

    // 1. Top lip rim: y in [-0.70, -0.58], half-width 0.56
    let d_rim = (ax - 0.56).max((v + 0.64).abs() - 0.065);

    // 2. Cup bowl: y in [-0.58, 0.16], tapered parabolic chalice
    let t_bowl = ((v + 0.58) / 0.74).clamp(0.0, 1.0);
    let w_bowl = 0.52 * (1.0 - 0.72 * t_bowl * t_bowl);
    let d_bowl = (ax - w_bowl).max((v + 0.21).abs() - 0.37);

    // 3. Side C-handles: elliptical ring centered at (0.50, -0.25)
    let hx = ax - 0.48;
    let hy = v + 0.26;
    let h_rad = (hx * hx + hy * hy).sqrt();
    let d_handle = ((h_rad - 0.23).abs() - 0.068).max(0.32 - ax);

    // 4. Stem: y in [0.14, 0.48]
    let d_stem = (ax - 0.11).max((v - 0.31).abs() - 0.17);

    // 5. Tiered pedestal base: upper step y in [0.46, 0.58], lower plinth y in [0.57, 0.72]
    let d_base1 = (ax - 0.34).max((v - 0.52).abs() - 0.065);
    let d_base2 = (ax - 0.48).max((v - 0.65).abs() - 0.075);

    d_rim
        .min(d_bowl)
        .min(d_handle)
        .min(d_stem)
        .min(d_base1)
        .min(d_base2)
}

/// Renders the anti-aliased medallion outer ring, rotating dashed orbit ring,
/// outer accent glow, dark velvet inner disc, and 3D metallic vector trophy
/// directly into the 32-bit DIB pixel buffer.
#[cfg(windows)]
fn render_medallion_and_trophy(
    pixels: &mut [u32],
    w: i32,
    h: i32,
    cx: i32,
    cy: i32,
    med_r: i32,
    colors: AchievementCardColors,
    t_sec: f32,
) {
    let (bg_r, bg_g, bg_b) = colorref_rgb(colors.background);
    let (ac_r, ac_g, ac_b) = colorref_rgb(colors.accent);
    let (ic_r, ic_g, ic_b) = colorref_rgb(colors.icon);

    let mr = med_r as f32;
    let inner_r = (mr - 2.6).max(4.0);
    let scale = (inner_r * 0.72).max(1.0);
    let pad = med_r + 15;

    for y in (cy - pad).max(0)..=(cy + pad).min(h - 1) {
        let dy = (y - cy) as f32;
        for x in (cx - pad).max(0)..=(cx + pad).min(w - 1) {
            let dx = (x - cx) as f32;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > mr + 14.0 {
                continue;
            }

            let idx = (y * w + x) as usize;
            let cur = pixels[idx];
            let mut r = ((cur >> 16) & 0xFF) as f32;
            let mut g = ((cur >> 8) & 0xFF) as f32;
            let mut b = (cur & 0xFF) as f32;

            // 1. Outer Glow Halo around medallion (matches CSS box-shadow: 0 0 18px ...)
            if dist > mr {
                let glow = (1.0 - (dist - mr) / 18.0).clamp(0.0, 1.0).powi(2) * 0.48;
                r += ac_r * glow;
                g += ac_g * glow;
                b += ac_b * glow;

                // 2. Rotating Dashed Orbit Ring with smooth subpixel anti-aliasing
                // Matches CSS .ach-medallion-ring: 1.5px dashed color-mix(icon 65%, transparent)
                let ring_r = mr + 5.0;
                let d_radial = (dist - ring_r).abs();
                if d_radial <= 1.35 {
                    // Crisp 1.5px stroke with subpixel anti-aliasing (0.75px half-width + 0.5px margin)
                    let rad_cov = (0.75 + 0.5 - d_radial).clamp(0.0, 1.0);

                    // Angular position and smooth feathered dash segments (24 sleek dashes around circumference)
                    // Synchronized with background god-rays: 8.0s per rotation, clockwise
                    let rot_speed = std::f32::consts::TAU / 8.0;
                    let period = std::f32::consts::TAU / 24.0;
                    let theta = dy.atan2(dx) - t_sec * rot_speed + (period * 0.5);
                    let half_dash = period * 0.275; // 55% dash (~4.5px), 45% gap
                    let local_theta = theta.rem_euclid(period) - (period * 0.5);
                    let d_ang_px = (half_dash - local_theta.abs()) * ring_r;
                    let ang_cov = (d_ang_px + 0.6).clamp(0.0, 1.0);

                    let dash_cov = rad_cov * ang_cov;
                    if dash_cov > 0.01 {
                        // Soft 68% opacity matching CSS color-mix(in srgb, var(--ach-icon) 65%, transparent)
                        let ring_alpha = dash_cov * 0.68;
                        r = r * (1.0 - ring_alpha) + (ic_r * 0.90 + 255.0 * 0.10) * ring_alpha;
                        g = g * (1.0 - ring_alpha) + (ic_g * 0.90 + 255.0 * 0.10) * ring_alpha;
                        b = b * (1.0 - ring_alpha) + (ic_b * 0.90 + 255.0 * 0.10) * ring_alpha;
                    }
                }
                pixels[idx] = pack_dib(r, g, b);
                continue;
            }

            // Outer anti-aliased medallion coverage
            let outer_cov = (mr + 0.6 - dist).clamp(0.0, 1.0);
            // Rim lighting gradient (brighter top-left, rich accent bottom-right)
            let rim_sheen = ((-dx - dy) / (mr * 2.0)).clamp(-0.5, 0.6) + 0.35;
            let rim_r = ac_r * (1.0 - rim_sheen * 0.45) + (ic_r * 0.5 + 255.0 * 0.5) * (rim_sheen * 0.45);
            let rim_g = ac_g * (1.0 - rim_sheen * 0.45) + (ic_g * 0.5 + 255.0 * 0.5) * (rim_sheen * 0.45);
            let rim_b = ac_b * (1.0 - rim_sheen * 0.45) + (ic_b * 0.5 + 255.0 * 0.5) * (rim_sheen * 0.45);

            // Inner velvet plate coverage
            let inner_cov = (inner_r + 0.5 - dist).clamp(0.0, 1.0);
            let core_glow = (1.0 - (dist / inner_r).min(1.0)).powi(2) * 0.32;
            let plate_r = bg_r * 0.48 + ac_r * core_glow;
            let plate_g = bg_g * 0.48 + ac_g * core_glow;
            let plate_b = bg_b * 0.48 + ac_b * core_glow;

            let mut disc_r = rim_r * (1.0 - inner_cov) + plate_r * inner_cov;
            let mut disc_g = rim_g * (1.0 - inner_cov) + plate_g * inner_cov;
            let mut disc_b = rim_b * (1.0 - inner_cov) + plate_b * inner_cov;

            // Vector Trophy Cup inside the inner disc
            if inner_cov > 0.05 {
                let u = dx / scale;
                let v = dy / scale;
                let sdf = trophy_sdf(u, v);
                let aa = 1.15 / scale;
                let cup_cov = ((aa - sdf) / (2.0 * aa)).clamp(0.0, 1.0) * inner_cov;
                if cup_cov > 0.0 {
                    // 3D cylindrical specular highlight across the cup bowl
                    let spec = (1.0 - (u + 0.18).abs() * 1.45).clamp(0.0, 1.0).powi(2);
                    let vert = (0.5 - v * 0.45).clamp(0.0, 1.0);
                    let pulse = (t_sec * 3.2).sin() * 0.08 + 0.92;
                    let tr = (ac_r * (1.0 - vert * 0.5) + ic_r * (vert * 0.5)) * pulse + 255.0 * spec * 0.42;
                    let tg = (ac_g * (1.0 - vert * 0.5) + ic_g * (vert * 0.5)) * pulse + 255.0 * spec * 0.42;
                    let tb = (ac_b * (1.0 - vert * 0.5) + ic_b * (vert * 0.5)) * pulse + 255.0 * spec * 0.42;
                    disc_r = disc_r * (1.0 - cup_cov) + tr * cup_cov;
                    disc_g = disc_g * (1.0 - cup_cov) + tg * cup_cov;
                    disc_b = disc_b * (1.0 - cup_cov) + tb * cup_cov;
                }
            }

            r = r * (1.0 - outer_cov) + disc_r * outer_cov;
            g = g * (1.0 - outer_cov) + disc_g * outer_cov;
            b = b * (1.0 - outer_cov) + disc_b * outer_cov;
            pixels[idx] = pack_dib(r, g, b);
        }
    }
}

/// Renders the animated 60 FPS background surface, shockwave rings, rotating
/// god-rays, diagonal holographic foil sweep, rotating conic border comet,
/// left gold accent bar gradient & glow, dopamine sparkling particles, and
/// the anti-aliased medallion + trophy emblem.
#[cfg(windows)]
fn render_dopamine_backdrop(
    pixels: &mut [u32],
    width: i32,
    height: i32,
    center_x: i32,
    center_y: i32,
    m: &NotifSizeMetrics,
    colors: AchievementCardColors,
    elapsed_ms: u64,
    style: u8,
    tier: u8,
    _progress_permille: u64,
) {
    let w = width.max(1);
    let h = height.max(1);
    let t_sec = elapsed_ms as f32 * 0.001;
    let (bg_r, bg_g, bg_b) = colorref_rgb(colors.background);
    let (ac_r, ac_g, ac_b) = colorref_rgb(colors.accent);
    let (ic_r, ic_g, ic_b) = colorref_rgb(colors.icon);
    let (bd_r, bd_g, bd_b) = colorref_rgb(colors.border);

    // Shockwave 1 (40..780ms) & Shockwave 2 (190..920ms)
    let sw1_p = ((elapsed_ms as f32 - 40.0) / 740.0).clamp(0.0, 1.0);
    let sw1_r = m.medallion_r as f32 * 0.7 + sw1_p * (w as f32 * 0.92);
    let sw1_amp = if elapsed_ms >= 40 && elapsed_ms <= 780 {
        (1.0 - sw1_p) * (1.0 - sw1_p)
    } else {
        0.0
    };

    let sw2_p = ((elapsed_ms as f32 - 190.0) / 730.0).clamp(0.0, 1.0);
    let sw2_r = m.medallion_r as f32 * 0.6 + sw2_p * (w as f32 * 0.72);
    let sw2_amp = if elapsed_ms >= 190 && elapsed_ms <= 920 {
        (1.0 - sw2_p) * (1.0 - sw2_p) * 0.85
    } else {
        0.0
    };

    let aura_inv = 1.0 / ((m.medallion_r as f32 * 4.2).max(50.0));
    let half_w = w as f32 * 0.5;
    let half_h = h as f32 * 0.5;
    let cur_w = (NOTIF_CUR_W.load(Ordering::Relaxed) as i32).clamp(16, w);

    for y in 0..h {
        let dy = (y - center_y) as f32;
        let dy2 = dy * dy;
        let row_offset = (y * w) as usize;
        let top_gloss = if y <= 1 { (1.0 - y as f32) * 0.08 } else { 0.0 };

        for x in 0..w {
            let dx = (x - center_x) as f32;
            let dist = (dx * dx + dy2).sqrt();

            // 1. Base surface + rich radial medallion aura (matches CSS radial-gradient)
            let aura = (1.0 - dist * aura_inv).max(0.0).powi(2) * 0.32;
            let mut r = bg_r + (ac_r - bg_r) * aura + 255.0 * top_gloss;
            let mut g = bg_g + (ac_g - bg_g) * aura + 255.0 * top_gloss;
            let mut b = bg_b + (ac_b - bg_b) * aura + 255.0 * top_gloss;

            // 2. Rotating Volumetric God-Rays behind the medallion (matches preview .ach-fx-godrays, 8s sync cycle)
            if dist < m.medallion_r as f32 * 3.8 {
                let angle = dy.atan2(dx);
                // Synchronized rotation speed with dashed ring: 8.0s per rotation, clockwise
                let rot_speed = std::f32::consts::TAU / 8.0;
                let rot_angle = angle - t_sec * rot_speed;
                // 12 rays around circle (matching CSS repeating-conic-gradient 30deg period)
                let beam = ((rot_angle * 12.0).cos() * 0.5 + 0.5).powi(3);
                let falloff = (1.0 - dist / (m.medallion_r as f32 * 3.8)).max(0.0);
                // Breathing scale factor matching CSS keyframe scale(0.96..1.06)
                let breathe = 0.95 + (t_sec * rot_speed).sin() * 0.08;
                let ray_int = beam * falloff * breathe * (if tier >= 3 { 0.36 } else { 0.22 });
                r += ic_r * ray_int;
                g += ic_g * ray_int;
                b += ic_b * ray_int;
            }

            // 3. Dual Expanding Shockwave Rings
            if sw1_amp > 0.0 {
                let d1 = (dist - sw1_r).abs();
                if d1 < 8.5 {
                    let ring = (1.0 - d1 / 8.5).powi(2) * sw1_amp;
                    r += (ic_r * 0.65 + 255.0 * 0.35) * ring * 0.85;
                    g += (ic_g * 0.65 + 255.0 * 0.35) * ring * 0.85;
                    b += (ic_b * 0.65 + 255.0 * 0.35) * ring * 0.85;
                }
            }
            if sw2_amp > 0.0 {
                let d2 = (dist - sw2_r).abs();
                if d2 < 6.0 {
                    let ring = (1.0 - d2 / 6.0).powi(2) * sw2_amp;
                    r += ac_r * ring * 0.70;
                    g += ac_g * ring * 0.70;
                    b += ac_b * ring * 0.70;
                }
            }

            // 4. Left Accent Indicator Bar: vertical gradient + 14px horizontal glow shadow (skipped on Xbox stadium pill style 4)
            if style != 4 && x < m.bar_width {
                let t_y = y as f32 / (h as f32).max(1.0);
                let (br, bg, bb) = if t_y < 0.22 {
                    let u = t_y / 0.22;
                    (255.0 * (1.0 - u) + ic_r * u, 255.0 * (1.0 - u) + ic_g * u, 255.0 * (1.0 - u) + ic_b * u)
                } else if t_y < 0.75 {
                    let u = (t_y - 0.22) / 0.53;
                    (ic_r * (1.0 - u) + ac_r * u, ic_g * (1.0 - u) + ac_g * u, ic_b * (1.0 - u) + ac_b * u)
                } else {
                    let u = (t_y - 0.75) / 0.25;
                    (ac_r * (1.0 - u) + bd_r * u, ac_g * (1.0 - u) + bd_g * u, ac_b * (1.0 - u) + bd_b * u)
                };
                r = br;
                g = bg;
                b = bb;
            } else if style != 4 && x >= m.bar_width && x < m.bar_width + 14 {
                let glow = (1.0 - (x - m.bar_width) as f32 / 14.0).powi(2) * 0.40;
                r += ac_r * glow;
                g += ac_g * glow;
                b += ac_b * glow;
            }

            // 5. Laser Slice (Cyber) high-tech scanner scanline sweep
            if style == 1 && elapsed_ms < 380 {
                let laser_p = elapsed_ms as f32 / 380.0;
                let laser_y = laser_p * (h as f32);
                let dy_laser = (y as f32 - laser_y).abs();
                if dy_laser < 5.0 {
                    let laser_int = (1.0 - dy_laser / 5.0).powi(2) * (1.0 - laser_p * 0.35);
                    r += (255.0 * 0.7 + ic_r * 0.3) * laser_int;
                    g += (255.0 * 0.7 + ic_g * 0.3) * laser_int;
                    b += (255.0 * 0.7 + ic_b * 0.3) * laser_int;
                }
            }

            // 6. Rotating Conic Energy Border Beam + Capsule Unroll Leading Rim
            let right_edge = (cur_w - 1).max(1);
            let is_in_card = x <= right_edge;
            let (is_border, edge_fade) = if !is_in_card {
                (false, 0.0)
            } else if style == 4 {
                // True Stadium Capsule SDF: radius R = h / 2
                let rad = (h as f32) * 0.5;
                let cap_r = rad.min((right_edge as f32) * 0.5);
                let xf = x as f32;
                let yf = y as f32;
                let d_edge = if xf < cap_r {
                    let d = (xf - cap_r).hypot(yf - rad);
                    (cap_r - d).abs()
                } else if xf > (right_edge as f32) - cap_r {
                    let d = (xf - ((right_edge as f32) - cap_r)).hypot(yf - rad);
                    (cap_r - d).abs()
                } else {
                    yf.min(h as f32 - 1.0 - yf)
                };
                if d_edge <= 2.2 {
                    let fade = (1.0 - d_edge / 2.2).clamp(0.0, 1.0);
                    (true, fade)
                } else {
                    (false, 0.0)
                }
            } else {
                // Smooth Rounded Rect with exact corner radius matching each style
                let cr = if style == 1 {
                    8.0f32
                } else if style == 6 {
                    10.0f32
                } else if style == 5 {
                    18.0f32
                } else {
                    16.0f32
                }.min((h as f32) * 0.5).min((right_edge as f32) * 0.5);

                let xf = x as f32;
                let yf = y as f32;
                let rf = right_edge as f32;
                let hf = h as f32 - 1.0;
                let d_edge = if xf < cr && yf < cr {
                    (cr - (xf - cr).hypot(yf - cr)).abs()
                } else if xf > rf - cr && yf < cr {
                    (cr - (xf - (rf - cr)).hypot(yf - cr)).abs()
                } else if xf > rf - cr && yf > hf - cr {
                    (cr - (xf - (rf - cr)).hypot(yf - (hf - cr))).abs()
                } else if xf < cr && yf > hf - cr {
                    (cr - (xf - cr).hypot(yf - (hf - cr))).abs()
                } else {
                    xf.min(rf - xf).min(yf.min(hf - yf))
                };
                if d_edge <= 2.2 {
                    let fade = (1.0 - d_edge / 2.2).clamp(0.0, 1.0);
                    (true, fade)
                } else {
                    (false, 0.0)
                }
            };

            if is_border {
                let b_angle = (y as f32 - half_h).atan2(x as f32 - half_w);
                let comet1 = ((b_angle - t_sec * 3.2).cos() * 0.5 + 0.5).powi(6);
                let comet2 = ((b_angle - t_sec * 3.2 + std::f32::consts::PI).cos() * 0.5 + 0.5).powi(6);
                let mut beam = (comet1 + comet2 * 0.7).clamp(0.0, 1.0);
                if cur_w < w && (right_edge - x) <= 3 {
                    beam = 1.0;
                }
                let br = bd_r * (1.0 - beam) + (ic_r * 0.6 + 255.0 * 0.4) * beam;
                let bg = bd_g * (1.0 - beam) + (ic_g * 0.6 + 255.0 * 0.4) * beam;
                let bb = bd_b * (1.0 - beam) + (ic_b * 0.6 + 255.0 * 0.4) * beam;
                r = r * (1.0 - edge_fade) + br * edge_fade;
                g = g * (1.0 - edge_fade) + bg * edge_fade;
                b = b * (1.0 - edge_fade) + bb * edge_fade;
            }

            pixels[row_offset + x as usize] = pack_dib(r, g, b);
        }
    }

    // 7. Dopamine Sparkling Particles ("parıltılı noktalar")
    // Part A: Initial dynamic burst shards (0..1000ms)
    let burst_t = ((elapsed_ms as f32 - 40.0) / 960.0).clamp(0.0, 1.0);
    if burst_t > 0.0 && burst_t < 1.0 {
        let decel = 1.0 - (1.0 - burst_t).powi(3);
        let fade = (1.0 - burst_t).powi(2);
        for i in 0..16u32 {
            let seed = (i.wrapping_mul(2654435761)) ^ ((tier as u32) << 16);
            let angle = (i as f32 / 16.0) * std::f32::consts::TAU + ((seed & 0xFF) as f32 * 0.012);
            let max_r = (m.medallion_r as f32) + 14.0 + ((seed >> 8) & 0x1F) as f32 * 0.6;
            let px = center_x + (angle.cos() * max_r * decel) as i32;
            let py = center_y + (angle.sin() * (max_r * 0.72) * decel) as i32;
            let is_diamond = (i & 1) == 0;
            draw_sparkle(pixels, w, h, px, py, 2, is_diamond, fade * 0.9, ic_r, ic_g, ic_b);
        }
    }

    // Part B: Persistent Orbiting Diamond Stars around the medallion disc (14 points, scaled to fit inside window bounds!)
    let entry_fade = (elapsed_ms as f32 / 240.0).clamp(0.0, 1.0);
    let mr_f = m.medallion_r as f32;
    for i in 0..14u32 {
        let angle = (i as f32 / 14.0) * std::f32::consts::TAU;
        let ring_dist = mr_f + 8.0 + ((i % 3) as f32) * 4.0;
        let phase = i as f32 * 0.75;
        let bob = (t_sec * 1.6 + phase).sin() * 2.5;
        let rad_dist = ring_dist + bob;
        // Keep vertical stretch slightly condensed so top/bottom never touch the window edge
        let px = center_x + (angle.cos() * rad_dist).round() as i32;
        let py = center_y + (angle.sin() * (rad_dist * 0.78)).round() as i32;

        let twinkle = ((t_sec * 3.5 + phase).sin().abs()).powi(3) * 0.78 + 0.22;
        let alpha = twinkle * entry_fade;
        let is_diamond = (i & 1) == 0;
        let sz = if is_diamond { 3 } else { 2 };
        draw_sparkle(pixels, w, h, px, py, sz, is_diamond, alpha, ic_r, ic_g, ic_b);
    }

    // Part C: Floating ambient sparkling embers across the card text area
    let text_area_w = (w - center_x - (m.medallion_r + 30)).max(60);
    for i in 0..10u32 {
        let seed = i.wrapping_mul(1597334677);
        let phase = (t_sec * (0.50 + (i as f32 * 0.05)) + (seed & 0xFF) as f32 * 0.04) % 1.0;
        let px = center_x + m.medallion_r + 28 + (((seed >> 8) as i32).abs() % text_area_w);
        let py = (h - 12) - (phase * (h - 24) as f32) as i32;
        let twinkle = ((phase * std::f32::consts::PI).sin()).powi(2) * 0.82;
        draw_sparkle(pixels, w, h, px, py, 2, (i & 1) == 0, twinkle, ac_r, ac_g, ac_b);
    }

    // 9. Anti-aliased Medallion Disc, Rotating Dashed Orbit Ring & 3D Vector Trophy Cup
    let impact_pulse = if elapsed_ms < 320 {
        let p = elapsed_ms as f32 / 320.0;
        ((p * std::f32::consts::PI).sin() * 2.5) as i32
    } else {
        0
    };
    let med_r = m.medallion_r + impact_pulse;
    render_medallion_and_trophy(pixels, w, h, center_x, center_y, med_r, colors, t_sec);
}

#[cfg(windows)]
fn draw_sparkle(
    pixels: &mut [u32],
    w: i32,
    h: i32,
    cx: i32,
    cy: i32,
    rad: i32,
    diamond: bool,
    alpha: f32,
    pr: f32,
    pg: f32,
    pb: f32,
) {
    if alpha <= 0.02 {
        return;
    }
    let r_bound = rad + 2;
    for dy in -r_bound..=r_bound {
        let y = cy + dy;
        if y < 0 || y >= h {
            continue;
        }
        let ady = dy.abs();
        for dx in -r_bound..=r_bound {
            let x = cx + dx;
            if x < 0 || x >= w {
                continue;
            }
            let adx = dx.abs();

            let dist_diamond = (adx + ady) as f32 / (rad as f32 + 0.6);
            let is_cross_ray = (adx == 0 && ady <= r_bound) || (ady == 0 && adx <= r_bound);

            let (intensity, is_white_core) = if adx == 0 && ady == 0 {
                (1.0, true)
            } else if adx <= 1 && ady <= 1 && (adx + ady) <= 1 {
                (0.92, true)
            } else if diamond && dist_diamond <= 1.0 {
                let falloff = (1.0 - dist_diamond).powi(2);
                (falloff, dist_diamond < 0.35)
            } else if is_cross_ray {
                let ray_dist = (adx.max(ady)) as f32 / (r_bound as f32 + 0.6);
                ((1.0 - ray_dist).powi(2) * 0.72, false)
            } else {
                let dist_circ = ((dx * dx + dy * dy) as f32).sqrt() / (rad as f32 + 0.6);
                if dist_circ <= 1.0 {
                    ((1.0 - dist_circ).powi(2) * 0.55, false)
                } else {
                    continue;
                }
            };

            let final_alpha = (intensity * alpha).clamp(0.0, 1.0);
            if final_alpha <= 0.01 {
                continue;
            }

            let idx = (y * w + x) as usize;
            let cur = pixels[idx];
            let cr = ((cur >> 16) & 0xFF) as f32;
            let cg = ((cur >> 8) & 0xFF) as f32;
            let cb = (cur & 0xFF) as f32;

            let (target_r, target_g, target_b) = if is_white_core {
                (255.0, 255.0, 255.0)
            } else {
                (pr * 0.7 + 255.0 * 0.3, pg * 0.7 + 255.0 * 0.3, pb * 0.7 + 255.0 * 0.3)
            };

            let nr = cr + target_r * final_alpha;
            let ng = cg + target_g * final_alpha;
            let nb = cb + target_b * final_alpha;
            pixels[idx] = pack_dib(nr, ng, nb);
        }
    }
}

/// The console-like card: double-buffered 32-bit DIB shader plate, medallion, and 3-tier typography.
#[cfg(windows)]
unsafe fn paint_notification(hdc: isize, rect: &RECT) {
    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);
    let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2) as usize;
    let m = size_metrics(size_code as u8);
    let colors = NOTIF_COLORS
        .lock()
        .map(|colors| *colors)
        .unwrap_or(GOLD_ACHIEVEMENT_CARD);
    let elapsed_ms = NOTIF_FRAME_MS.load(Ordering::Relaxed);
    let style = NOTIF_STYLE.load(Ordering::Relaxed);
    let tier = NOTIF_RARITY_TIER.load(Ordering::Relaxed);
    let progress_permille = NOTIF_PROGRESS_PERMILLE.load(Ordering::Relaxed);

    let mem_dc = CreateCompatibleDC(hdc);
    let bmi = BITMAPINFOHEADER {
        bi_size: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        bi_width: width,
        bi_height: -height, // top-down DIB
        bi_planes: 1,
        bi_bit_count: 32,
        bi_compression: 0, // BI_RGB
        bi_size_image: 0,
        bi_x_pels_per_meter: 0,
        bi_y_pels_per_meter: 0,
        bi_clr_used: 0,
        bi_clr_important: 0,
    };
    let mut bits: *mut u32 = std::ptr::null_mut();
    let dib = if mem_dc != 0 {
        CreateDIBSection(hdc, &bmi, 0, &mut bits, 0, 0)
    } else {
        0
    };

    let target_dc = if dib != 0 && !bits.is_null() {
        SelectObject(mem_dc, dib);
        mem_dc
    } else {
        hdc
    };

    let center_x = if style == 4 {
        rect.left + height / 2
    } else {
        rect.left + m.left_pad + m.medallion_r
    };
    let center_y = (rect.top + rect.bottom) / 2;

    if dib != 0 && !bits.is_null() {
        let slice = std::slice::from_raw_parts_mut(bits, (width * height) as usize);
        render_dopamine_backdrop(
            slice,
            width,
            height,
            center_x,
            center_y,
            &m,
            colors,
            elapsed_ms,
            style,
            tier,
            progress_permille,
        );
    } else {
        let plate = CreateSolidBrush(colors.background);
        FillRect(target_dc, rect, plate);
        let _ = DeleteObject(plate);
    }

    // If the achievement's own icon has downloaded, paint it inside the medallion core;
    // otherwise the anti-aliased 3D vector trophy rendered into the DIB remains visible.
    let inner_r = (m.medallion_r - 3).max(4);
    let _ = paint_medallion_picture(target_dc, center_x, center_y, inner_r);

    // Text column: painted once the capsule has unfurled past the medallion
    let (text_left, text_right) = if style == 4 {
        let t_l = rect.left + (height / 2) + m.medallion_r + 26;
        let t_r = rect.right - (height / 2) - 24;
        (t_l, t_r)
    } else {
        (rect.left + m.text_left, rect.right - m.text_right)
    };
    if text_right > text_left + 24 {
        SetBkMode(target_dc, TRANSPARENT_BK);
        let has_tag = NOTIF_TAG.lock().map(|t| t.len() > 1).unwrap_or(false);

        if has_tag {
            let tag_font = SIZE_TAG_FONTS[size_code].load(Ordering::Relaxed);
            if let Ok(tag) = NOTIF_TAG.lock() {
                if tag.len() > 1 {
                    if tag_font != 0 {
                        SelectObject(target_dc, tag_font);
                    }
                    SetTextColor(target_dc, colors.accent);
                    let mut tag_rect = RECT {
                        left: text_left,
                        top: rect.top + m.tag_top,
                        right: text_right,
                        bottom: rect.top + m.tag_bottom,
                    };
                    DrawTextW(
                        target_dc,
                        tag.as_ptr(),
                        (tag.len() - 1) as i32,
                        &mut tag_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                }
            }

            let title_font = SIZE_TITLE_FONTS[size_code].load(Ordering::Relaxed);
            if let Ok(title) = NOTIF_TITLE.lock() {
                if title.len() > 1 {
                    if title_font != 0 {
                        SelectObject(target_dc, title_font);
                    }
                    // Subtle 1px dark drop shadow so title pops over shimmer/particles
                    SetTextColor(target_dc, 0x00050505);
                    let mut shadow_rect = RECT {
                        left: text_left + 1,
                        top: rect.top + m.title_top + 1,
                        right: text_right + 1,
                        bottom: rect.top + m.title_bottom + 1,
                    };
                    DrawTextW(
                        target_dc,
                        title.as_ptr(),
                        (title.len() - 1) as i32,
                        &mut shadow_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                    SetTextColor(target_dc, colors.title);
                    let mut title_rect = RECT {
                        left: text_left,
                        top: rect.top + m.title_top,
                        right: text_right,
                        bottom: rect.top + m.title_bottom,
                    };
                    DrawTextW(
                        target_dc,
                        title.as_ptr(),
                        (title.len() - 1) as i32,
                        &mut title_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                }
            }

            let body_font = SIZE_BODY_FONTS[size_code].load(Ordering::Relaxed);
            if let Ok(body) = NOTIF_BODY.lock() {
                if body.len() > 1 {
                    if body_font != 0 {
                        SelectObject(target_dc, body_font);
                    }
                    SetTextColor(target_dc, colors.body);
                    let mut body_rect = RECT {
                        left: text_left,
                        top: rect.top + m.body_top,
                        right: text_right,
                        bottom: rect.top + m.body_bottom,
                    };
                    DrawTextW(
                        target_dc,
                        body.as_ptr(),
                        (body.len() - 1) as i32,
                        &mut body_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                }
            }
        } else {
            let title_font = SIZE_TITLE_FONTS[size_code].load(Ordering::Relaxed);
            if let Ok(title) = NOTIF_TITLE.lock() {
                if title.len() > 1 {
                    if title_font != 0 {
                        SelectObject(target_dc, title_font);
                    }
                    SetTextColor(target_dc, colors.title);
                    let mut text_rect = RECT {
                        left: text_left,
                        top: rect.top + m.title_top - 6,
                        right: text_right,
                        bottom: rect.top + m.title_bottom + 6,
                    };
                    DrawTextW(
                        target_dc,
                        title.as_ptr(),
                        (title.len() - 1) as i32,
                        &mut text_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                }
            }
            let body_font = SIZE_BODY_FONTS[size_code].load(Ordering::Relaxed);
            if let Ok(body) = NOTIF_BODY.lock() {
                if body.len() > 1 {
                    if body_font != 0 {
                        SelectObject(target_dc, body_font);
                    }
                    SetTextColor(target_dc, colors.body);
                    let mut text_rect = RECT {
                        left: text_left,
                        top: rect.top + m.body_top,
                        right: text_right,
                        bottom: rect.top + m.body_bottom + 6,
                    };
                    DrawTextW(
                        target_dc,
                        body.as_ptr(),
                        (body.len() - 1) as i32,
                        &mut text_rect,
                        NOTIF_TEXT_FORMAT,
                    );
                }
            }
        }
    }

    if dib != 0 {
        BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, 0x00CC_0020 /* SRCCOPY */);
        let _ = DeleteObject(dib);
    }
    if mem_dc != 0 {
        let _ = DeleteDC(mem_dc);
    }
}

/// Creates the HUD window on its own thread and pumps its message loop.
#[cfg(windows)]
fn ensure_window() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| unsafe {
        let class_name: Vec<u16> = "EfxlveOverlayHud\0".encode_utf16().collect();
        let class = WNDCLASSW {
            style: 0,
            lpfn_wnd_proc: Some(hud_wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: GetModuleHandleW(std::ptr::null()),
            h_icon: 0,
            h_cursor: 0,
            hbr_background: 0,
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        RegisterClassW(&class);
        let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
        let font = CreateFontW(-14, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
        FONT.store(font, Ordering::Relaxed);
        let has_glyph = std::path::Path::new(r"C:\Windows\Fonts\segmdl2.ttf").exists();
        let glyph_face: Vec<u16> = if has_glyph {
            "Segoe MDL2 Assets\0".encode_utf16().collect()
        } else {
            Vec::new()
        };

        for i in 0..4 {
            let m = size_metrics(i as u8);
            let tag_f = CreateFontW(-m.tag_px, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_TAG_FONTS[i].store(tag_f, Ordering::Relaxed);
            let title_f = CreateFontW(-m.title_px, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_TITLE_FONTS[i].store(title_f, Ordering::Relaxed);
            let body_f = CreateFontW(-m.body_px, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_BODY_FONTS[i].store(body_f, Ordering::Relaxed);
            if has_glyph {
                let icon_f = CreateFontW(-m.icon_size, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, glyph_face.as_ptr());
                SIZE_ICON_FONTS[i].store(icon_f, Ordering::Relaxed);
            }
        }
        TAG_FONT.store(SIZE_TAG_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        TITLE_FONT.store(SIZE_TITLE_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        BODY_FONT.store(SIZE_BODY_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        ICON_FONT.store(SIZE_ICON_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);

        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_POPUP,
            16,
            16,
            320,
            30,
            0,
            0,
            GetModuleHandleW(std::ptr::null()),
            0,
        );
        if hwnd == 0 {
            return;
        }
        // Alpha-blended dark plate; the window itself is click-through.
        SetLayeredWindowAttributes(hwnd, 0, 215, 0x0000_0002 /* LWA_ALPHA */);
        HWND.store(hwnd, Ordering::SeqCst);

        let mut msg = [0u8; 128];
        while GetMessageW(msg.as_mut_ptr(), 0, 0, 0) > 0 {
            TranslateMessage(msg.as_ptr());
            DispatchMessageW(msg.as_ptr());
        }
    });
    // First caller waits briefly for the window: a one-shot hint must not be
    // lost to the creation race (the metrics HUD retries every second).
    for _ in 0..50 {
        if HWND.load(Ordering::SeqCst) != 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::{notif_rect, text_px, NOTIF_HEIGHT, NOTIF_MARGIN};

    #[test]
    fn notification_card_sits_at_the_top_right() {
        let (x, y, width, height) = notif_rect(0, 0, 1920, 1080, 0, 200, 400);
        assert_eq!(height, NOTIF_HEIGHT);
        assert_eq!(y, NOTIF_MARGIN);
        // The card hugs the right edge and never leaves a bigger gap.
        assert!(width >= 360);
        assert_eq!(x + width + NOTIF_MARGIN, 1920);
    }

    #[test]
    fn notification_card_fits_an_offset_monitor() {
        let (x, y, width, _) = notif_rect(1920, 100, 1280, 720, 0, 800, 1200);
        assert!(x >= 1920);
        assert!(x + width <= 1920 + 1280 - NOTIF_MARGIN);
        assert_eq!(y, 100 + NOTIF_MARGIN);
    }

    #[test]
    fn notification_card_clamps_to_a_narrow_monitor() {
        let (_, _, width, _) = notif_rect(0, 0, 800, 1080, 0, 2000, 2000);
        assert_eq!(width, 800 - 2 * NOTIF_MARGIN);
    }

    #[test]
    fn a_longer_line_makes_a_wider_card() {
        let (_, _, narrow, _) = notif_rect(0, 0, 1920, 1080, 0, text_px(&[b'a' as u16; 10], 15), 0);
        let (_, _, wide, _) = notif_rect(0, 0, 1920, 1080, 0, text_px(&[b'a' as u16; 80], 15), 0);
        assert!(wide > narrow);
    }

    #[test]
    fn notification_card_can_sit_at_the_bottom_left() {
        let (x, y, width, height) = notif_rect(100, 50, 1920, 1080, 3, 200, 400);
        assert_eq!(x, 100 + NOTIF_MARGIN);
        assert_eq!(y + height + NOTIF_MARGIN, 50 + 1080);
        assert!(width >= 360);
    }

    #[test]
    fn notification_card_can_sit_centered() {
        let (x, y, width, _) = notif_rect(0, 0, 1920, 1080, 4, 200, 400);
        assert_eq!(x, (1920 - width) / 2);
        assert_eq!(y, NOTIF_MARGIN);
        let (_, bottom_y, _, height) = notif_rect(0, 0, 1920, 1080, 5, 200, 400);
        assert_eq!(bottom_y + height + NOTIF_MARGIN, 1080);
    }

    #[test]
    fn cjk_glyphs_measure_a_full_em() {
        let cjk = text_px(&[0x65E5, 0x672C], 15);
        let latin = text_px(&[b'a' as u16, b'b' as u16], 15);
        assert_eq!(cjk, 30);
        assert!(latin < cjk);
    }

    #[test]
    #[cfg(windows)]
    fn card_palettes_keep_colorref_byte_order() {
        assert_eq!(
            super::colorref_rgb(super::GOLD_ACHIEVEMENT_CARD.accent),
            (0xF5 as f32, 0x9E as f32, 0x0B as f32)
        );
        assert_eq!(
            super::colorref_rgb(super::CYBER_ACHIEVEMENT_CARD.accent),
            (0x00 as f32, 0xF0 as f32, 0xFF as f32)
        );
        assert_eq!(
            super::colorref_rgb(super::rarity_card_colors(4).accent),
            (0xE8 as f32, 0x79 as f32, 0xF9 as f32)
        );
        assert!(super::trophy_sdf(0.0, -0.25) < 0.0);
        assert!(super::trophy_sdf(0.95, -0.95) > 0.0);
    }

    /// The medallion draws the achievement's picture through GDI+; a broken
    /// declaration or a missing codec must not silently paint nothing.
    #[test]
    #[cfg(windows)]
    fn a_downloaded_icon_paints_inside_the_medallion() {
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "user32")]
        extern "system" {
            fn GetDC(hwnd: isize) -> isize;
            fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        }
        #[link(name = "gdi32")]
        extern "system" {
            fn CreateCompatibleDC(hdc: isize) -> isize;
            fn CreateCompatibleBitmap(hdc: isize, width: i32, height: i32) -> isize;
            fn DeleteDC(hdc: isize) -> i32;
        }

        // A one-pixel PNG: enough for the decoder to answer with a bitmap.
        let bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let path = std::env::temp_dir().join(format!(
            "efxlve-achievement-icon-{}.png",
            std::process::id()
        ));
        std::fs::write(&path, &bytes).expect("write the test picture");
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        *super::NOTIF_ICON.lock().expect("icon slot") = Some(wide);

        unsafe {
            let screen = GetDC(0);
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, 64, 64);
            let previous = super::SelectObject(dc, bitmap);
            assert!(
                super::paint_medallion_picture(dc, 32, 32, 24),
                "the icon decodes and draws"
            );
            super::SelectObject(dc, previous);
            super::DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(0, screen);
        }
        *super::NOTIF_ICON.lock().expect("icon slot") = None;
        let _ = std::fs::remove_file(&path);
    }
}
