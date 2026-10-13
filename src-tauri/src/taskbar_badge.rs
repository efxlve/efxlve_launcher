//! The taskbar overlay badge: a red circle with the unread count, drawn as raw
//! RGBA and handed to Tauri's `set_overlay_icon` — the same badge Discord puts
//! on its taskbar button. Pure Rust, so no GDI or COM setup is involved.

use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// 3x5 pixel glyphs: enough for "0"-"9" and "+".
const GLYPHS: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b001, 0b001, 0b001], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
    [0b000, 0b010, 0b111, 0b010, 0b000], // +
];

/// The badge: a filled circle in the launcher's error red with the count in
/// white, centred.
fn badge_image(count: u32) -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = (SIZE as f32 - 1.0) / 2.0;
    let radius = center;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            // A soft edge keeps the circle from looking jagged when Windows
            // scales it down to 16 px.
            let alpha = ((radius - distance).clamp(0.0, 1.0) * 255.0) as u8;
            if alpha == 0 {
                continue;
            }
            let index = ((y * SIZE + x) * 4) as usize;
            rgba[index] = 0xe5;
            rgba[index + 1] = 0x48;
            rgba[index + 2] = 0x4d;
            rgba[index + 3] = alpha;
        }
    }
    let text = if count > 9 {
        "9+".to_string()
    } else {
        count.to_string()
    };
    draw_text(&mut rgba, SIZE, &text);
    Image::new_owned(rgba, SIZE, SIZE)
}

/// Draws the count with the pixel glyphs, centred in the badge.
fn draw_text(rgba: &mut [u8], size: u32, text: &str) {
    const GLYPH_W: u32 = 3;
    const GLYPH_H: u32 = 5;
    let scale = if text.len() > 1 { 2 } else { 3 };
    let gap = scale;
    let total_w = (GLYPH_W * scale + gap) * text.len() as u32 - gap;
    let total_h = GLYPH_H * scale;
    let start_x = (size - total_w) / 2;
    let start_y = (size - total_h) / 2;
    for (index, ch) in text.chars().enumerate() {
        let glyph = match ch {
            '0'..='9' => GLYPHS[ch as usize - '0' as usize],
            '+' => GLYPHS[10],
            _ => continue,
        };
        let offset_x = start_x + index as u32 * (GLYPH_W * scale + gap);
        for row in 0..GLYPH_H {
            for col in 0..GLYPH_W {
                if glyph[row as usize] & (1 << (GLYPH_W - 1 - col)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = offset_x + col * scale + dx;
                        let y = start_y + row * scale + dy;
                        if x >= size || y >= size {
                            continue;
                        }
                        let pixel = ((y * size + x) * 4) as usize;
                        rgba[pixel] = 255;
                        rgba[pixel + 1] = 255;
                        rgba[pixel + 2] = 255;
                        rgba[pixel + 3] = 255;
                    }
                }
            }
        }
    }
}

/// Sets (or clears, with `count` 0) the taskbar overlay badge on the launcher's
/// window. The UI calls this whenever the unread count changes.
#[tauri::command]
pub fn app_set_taskbar_badge(app: AppHandle, count: u32) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    if count == 0 {
        return window
            .set_overlay_icon(None)
            .map_err(|error| error.to_string());
    }
    window
        .set_overlay_icon(Some(badge_image(count)))
        .map_err(|error| error.to_string())
}
