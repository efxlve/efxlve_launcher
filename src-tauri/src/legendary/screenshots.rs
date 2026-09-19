use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Emitter};

static RUNNING_GAME: RwLock<Option<(String, String)>> = RwLock::new(None);

pub fn set_active_running_game(app_name: &str, title: &str) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        *g = Some((app_name.to_string(), title.to_string()));
    }
}

pub fn clear_active_running_game(app_name: &str) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        if let Some((ref cur, _)) = *g {
            if cur == app_name {
                *g = None;
            }
        }
    }
}

pub fn get_active_running_game() -> Option<(String, String)> {
    RUNNING_GAME.read().ok().and_then(|g| g.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameScreenshotItem {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub date_str: String,
    pub timestamp: u64,
    pub size_bytes: u64,
    pub size_str: String,
    pub data_url: String,
}

pub fn clean_folder_name(name: &str) -> String {
    name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn get_user_pictures_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("Pictures")
    } else {
        std::env::temp_dir()
    }
}

pub fn get_user_videos_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("Videos")
    } else {
        std::env::temp_dir()
    }
}

pub fn game_screenshots_dir(clean_title: &str) -> PathBuf {
    get_user_pictures_dir()
        .join("Efxlve Screenshots")
        .join(clean_title)
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

fn file_to_data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn parse_file_to_item(path: &Path) -> Option<GameScreenshotItem> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp") {
        return None;
    }

    let file_name = path.file_name()?.to_string_lossy().to_string();
    let size_bytes = metadata.len();
    let size_str = format_bytes(size_bytes);

    let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let duration = modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let timestamp = duration.as_secs();

    // Basit ve temiz tarih formatı
    let datetime = chrono_fallback(timestamp);
    let data_url = file_to_data_url(path)?;

    Some(GameScreenshotItem {
        id: format!("{}_{}", file_name, timestamp),
        file_path: path.to_string_lossy().to_string(),
        file_name,
        date_str: datetime,
        timestamp,
        size_bytes,
        size_str,
        data_url,
    })
}

fn chrono_fallback(epoch_sec: u64) -> String {
    // Harici chrono bağımlılığı yerine hafif yerel zaman formatı
    // Windows dosya zamanı veya standart tarih
    let days_since_epoch = epoch_sec / 86400;
    let day_sec = epoch_sec % 86400;
    let hours = (day_sec / 3600) % 24;
    let minutes = (day_sec / 60) % 60;
    let seconds = day_sec % 60;

    // Yaklaşık takvim tarihi
    let mut year = 1970;
    let mut days_left = days_since_epoch;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if days_left < days_in_year {
            break;
        }
        days_left -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &d in &month_days {
        if days_left < d {
            break;
        }
        days_left -= d;
        month += 1;
    }
    let day = days_left + 1;
    format!("{:02}.{:02}.{} {:02}:{:02}:{:02}", day, month, year, hours, minutes, seconds)
}

/// Oyunun tüm ekran görüntülerini diskten tarar ve döndürür.
#[tauri::command]
pub async fn epic_get_game_screenshots(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<Vec<GameScreenshotItem>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let clean_t = clean_folder_name(&title);
        let clean_app = clean_folder_name(&app_name);

        let mut scanned_paths = std::collections::HashSet::new();

        // 1. Dedicated Efxlve Screenshots klasörleri: %USERPROFILE%\Pictures\Efxlve Screenshots\<clean_t>
        let dirs_to_check = vec![
            game_screenshots_dir(&clean_t),
            game_screenshots_dir(&clean_app),
            get_user_pictures_dir().join(&clean_t),
        ];

        for dir in dirs_to_check {
            if dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if scanned_paths.insert(path.clone()) {
                            if let Some(item) = parse_file_to_item(&path) {
                                results.push(item);
                            }
                        }
                    }
                }
            }
        }

        // 2. Windows Game Bar / Captures klasörü: %USERPROFILE%\Videos\Captures
        let captures_dir = get_user_videos_dir().join("Captures");
        if captures_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&captures_dir) {
                let lower_title = clean_t.to_lowercase();
                let lower_app = clean_app.to_lowercase();
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                    // Dosya adı oyun başlığını veya app_name'i içeriyorsa eşle
                    if (name.contains(&lower_title) || (!lower_app.is_empty() && name.contains(&lower_app)))
                        && scanned_paths.insert(path.clone())
                    {
                        if let Some(item) = parse_file_to_item(&path) {
                            results.push(item);
                        }
                    }
                }
            }
        }

        // En yeniden en eskiye sırala
        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
mod win_capture {
    use std::ffi::c_void;
    use std::path::Path;

    type HDC = *mut c_void;
    type HBITMAP = *mut c_void;
    type HGDIOBJ = *mut c_void;
    type HWND = *mut c_void;
    type BOOL = i32;

    const DESKTOPHORZRES: i32 = 118;
    const DESKTOPVERTRES: i32 = 117;
    const SRCCOPY: u32 = 0x00CC0020;

    #[repr(C)]
    struct GdiplusStartupInput {
        gdiplus_version: u32,
        debug_event_callback: usize,
        suppress_background_thread: BOOL,
        suppress_external_codecs: BOOL,
    }

    #[repr(C)]
    struct GUID {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    // CLSID for ImageFormatPNG: {557cf406-1a04-11d3-9a73-0000f81ef32e}
    const CLSID_PNG: GUID = GUID {
        data1: 0x557cf406,
        data2: 0x1a04,
        data3: 0x11d3,
        data4: [0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e],
    };

    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(dwFlags: u32, fInherit: BOOL, dwDesiredAccess: u32) -> *mut c_void;
        fn SetThreadDesktop(hDesktop: *mut c_void) -> BOOL;
        fn CloseDesktop(hDesktop: *mut c_void) -> BOOL;
        fn GetDC(hwnd: HWND) -> HDC;
        fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
        fn GetSystemMetrics(nIndex: i32) -> i32;
        fn SetProcessDPIAware() -> BOOL;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn GetDeviceCaps(hdc: HDC, index: i32) -> i32;
        fn CreateCompatibleDC(hdc: HDC) -> HDC;
        fn CreateDIBSection(
            hdc: HDC,
            pbmi: *const BITMAPINFO,
            usage: u32,
            ppv_bits: *mut *mut c_void,
            h_section: *mut c_void,
            offset: u32,
        ) -> HBITMAP;
        fn SelectObject(hdc: HDC, h: HGDIOBJ) -> HGDIOBJ;
        fn BitBlt(
            hdc_dst: HDC,
            x_dst: i32,
            y_dst: i32,
            w: i32,
            h: i32,
            hdc_src: HDC,
            x_src: i32,
            y_src: i32,
            rop: u32,
        ) -> BOOL;
        fn DeleteDC(hdc: HDC) -> BOOL;
        fn DeleteObject(ho: HGDIOBJ) -> BOOL;
    }

    #[repr(C)]
    struct BITMAPINFOHEADER {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_xpels_per_meter: i32,
        bi_ypels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }

    #[repr(C)]
    struct BITMAPINFO {
        bmi_header: BITMAPINFOHEADER,
        bmi_colors: [u32; 1],
    }

    #[link(name = "gdiplus")]
    extern "system" {
        fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> i32;
        fn GdiplusShutdown(token: usize);
        fn GdipCreateBitmapFromHBITMAP(hbm: HBITMAP, hpal: *mut c_void, bitmap: *mut *mut c_void) -> i32;
        fn GdipSaveImageToFile(
            image: *mut c_void,
            filename: *const u16,
            clsidEncoder: *const GUID,
            encoderParams: *const c_void,
        ) -> i32;
        fn GdipDisposeImage(image: *mut c_void) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(dwErrCode: u32);
    }

    pub fn capture_screen_native(target_file: &Path) -> Result<(), String> {
        let target_path = target_file.to_path_buf();
        std::thread::spawn(move || capture_screen_native_thread(&target_path))
            .join()
            .map_err(|_| "Worker thread panicked".to_string())?
    }

    fn capture_screen_native_thread(target_file: &Path) -> Result<(), String> {
        unsafe {
            let _ = SetProcessDPIAware();

            // Aktif masaüstüne (input desktop) bağlan — BitBlt'in ERROR_INVALID_HANDLE vermesini önler
            let h_desk = OpenInputDesktop(0, 0, 0x01FF);
            if !h_desk.is_null() {
                let _ = SetThreadDesktop(h_desk);
            }

            let hdc_screen = GetDC(std::ptr::null_mut());
            if hdc_screen.is_null() {
                if !h_desk.is_null() {
                    CloseDesktop(h_desk);
                }
                return Err(format!("GetDC failed (err: {})", GetLastError()));
            }

            let mut width = GetDeviceCaps(hdc_screen, DESKTOPHORZRES);
            let mut height = GetDeviceCaps(hdc_screen, DESKTOPVERTRES);

            if width <= 0 || height <= 0 {
                width = GetDeviceCaps(hdc_screen, 8 /* HORZRES */);
                height = GetDeviceCaps(hdc_screen, 10 /* VERTRES */);
            }
            if width <= 0 || height <= 0 {
                width = GetSystemMetrics(0 /* SM_CXSCREEN */);
                height = GetSystemMetrics(1 /* SM_CYSCREEN */);
            }

            if width <= 0 || height <= 0 {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err("Ekran çözünürlüğü tespit edilemedi".to_string());
            }

            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(format!("CreateCompatibleDC failed (err: {})", GetLastError()));
            }

            // CreateDIBSection ile bellek havuzu limiti olmadan yüksek çözünürlükte bitmap tahsis et
            let bmi = BITMAPINFO {
                bmi_header: BITMAPINFOHEADER {
                    bi_size: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    bi_width: width,
                    bi_height: -height, // top-down
                    bi_planes: 1,
                    bi_bit_count: 32,
                    bi_compression: 0, // BI_RGB
                    bi_size_image: (width * height * 4) as u32,
                    bi_xpels_per_meter: 0,
                    bi_ypels_per_meter: 0,
                    bi_clr_used: 0,
                    bi_clr_important: 0,
                },
                bmi_colors: [0],
            };

            let mut ppv_bits: *mut c_void = std::ptr::null_mut();
            let h_bitmap = CreateDIBSection(
                hdc_mem,
                &bmi,
                0, // DIB_RGB_COLORS
                &mut ppv_bits,
                std::ptr::null_mut(),
                0,
            );

            if h_bitmap.is_null() {
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(format!("CreateDIBSection failed (err: {})", GetLastError()));
            }

            let h_old = SelectObject(hdc_mem, h_bitmap);
            SetLastError(0);
            let blt_ok = BitBlt(
                hdc_mem,
                0,
                0,
                width,
                height,
                hdc_screen,
                0,
                0,
                SRCCOPY,
            );
            let err_code = GetLastError();

            SelectObject(hdc_mem, h_old);
            DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);

            if blt_ok == 0 {
                DeleteObject(h_bitmap);
                return Err(format!(
                    "BitBlt failed (err: {}, w: {}, h: {})",
                    err_code, width, height
                ));
            }

            // 4. GDI+ ile yerel C hızında doğrudan PNG olarak kaydet (~15 ms)
            let startup_input = GdiplusStartupInput {
                gdiplus_version: 1,
                debug_event_callback: 0,
                suppress_background_thread: 0,
                suppress_external_codecs: 0,
            };

            let mut token: usize = 0;
            let status = GdiplusStartup(&mut token, &startup_input, std::ptr::null_mut());
            if status != 0 {
                DeleteObject(h_bitmap);
                return Err(format!("GdiplusStartup failed (status: {})", status));
            }

            let mut gdip_image: *mut c_void = std::ptr::null_mut();
            let create_status = GdipCreateBitmapFromHBITMAP(h_bitmap, std::ptr::null_mut(), &mut gdip_image);

            DeleteObject(h_bitmap);

            if create_status != 0 || gdip_image.is_null() {
                GdiplusShutdown(token);
                return Err(format!("GdipCreateBitmapFromHBITMAP failed (status: {})", create_status));
            }

            let wide_path: Vec<u16> = target_file
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let save_status = GdipSaveImageToFile(
                gdip_image,
                wide_path.as_ptr(),
                &CLSID_PNG,
                std::ptr::null(),
            );

            GdipDisposeImage(gdip_image);
            GdiplusShutdown(token);

            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }

            if save_status != 0 {
                return Err(format!("GdipSaveImageToFile failed (status: {})", save_status));
            }

            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win_capture {
    use std::path::Path;
    pub fn capture_screen_native(_target_file: &Path) -> Result<(), String> {
        Err("Native screen capture only supported on Windows".to_string())
    }
}

/// Senkron olarak birincil ekranın görüntüsünü alır ve ilgili oyun klasörüne kaydeder.
pub fn capture_game_screenshot_sync(app_name: &str, title: &str) -> Result<GameScreenshotItem, String> {
    let clean_t = if !title.trim().is_empty() {
        clean_folder_name(title)
    } else {
        clean_folder_name(app_name)
    };
    let target_dir = game_screenshots_dir(&clean_t);
    let _ = std::fs::create_dir_all(&target_dir);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_name = format!("{}_Screenshot_{}.png", clean_t.replace(' ', "_"), timestamp);
    let target_file = target_dir.join(&file_name);

    // 1. Önce native Win32 GDI + GDI+ dene (< 20 ms, tam fiziksel çözünürlük)
    let native_res = win_capture::capture_screen_native(&target_file);

    if native_res.is_err() {
        // 2. Fallback: DPI-Aware PowerShell komutu (tam 2560x1600 çözünürlük)
        let target_str = target_file.to_string_lossy().to_string();
        let ps_code = format!(
            r#"
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiAware {{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }}' -ErrorAction SilentlyContinue
[DpiAware]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
"#,
            target_str.replace('\'', "''")
        );

        let utf16_bytes: Vec<u8> = ps_code.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let encoded_cmd = base64::engine::general_purpose::STANDARD.encode(&utf16_bytes);

        let _ = std::process::Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-EncodedCommand")
            .arg(&encoded_cmd)
            .status();

        if !target_file.exists() {
            return Err(format!(
                "Ekran görüntüsü alınamadı (native: {:?})",
                native_res.err()
            ));
        }
    }

    parse_file_to_item(&target_file).ok_or_else(|| "Ekran görüntüsü dosyası okunamadı".to_string())
}

/// Ekran görüntüsü alır ve oyunun klasörüne kaydeder.
#[tauri::command]
pub async fn epic_capture_game_screenshot(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<GameScreenshotItem, String> {
    tokio::task::spawn_blocking(move || {
        capture_game_screenshot_sync(&app_name, &title)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyun açıkken F12 tuşuna basıldığında ekran görüntüsü yakalayan arka plan dinleyicisi.
#[cfg(target_os = "windows")]
pub fn start_f12_listener(app: AppHandle) {
    std::thread::spawn(move || {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(vKey: i32) -> i16;
        }

        const VK_F12: i32 = 0x7B;
        let mut was_down = false;
        let mut last_capture_time = std::time::Instant::now() - std::time::Duration::from_secs(10);

        loop {
            std::thread::sleep(std::time::Duration::from_millis(20));

            // Sadece bir oyun aktif oynanıyorken F12'yi kontrol et
            let running = get_active_running_game();
            if running.is_none() {
                was_down = false;
                continue;
            }

            let state = unsafe { GetAsyncKeyState(VK_F12) };
            let is_down = (state as u16 & 0x8000) != 0;

            if is_down && !was_down {
                // F12 tuşuna basıldı! (Key Down Edge)
                if last_capture_time.elapsed() >= std::time::Duration::from_millis(400) {
                    last_capture_time = std::time::Instant::now();
                    if let Some((app_name, title)) = running {
                        // 1. ANINDA DEKLANŞÖR TETİKLEMESİ (0 ms gecikmeyle deklanşör sesi ve UI uyarısı)
                        let _ = app.emit(
                            "screenshot-shutter",
                            serde_json::json!({
                                "id": app_name,
                                "title": title,
                            }),
                        );

                        // 2. Arka planda donanımsal ekran görüntüsü kaydı (< 110 ms)
                        let app_clone = app.clone();
                        let app_name_clone = app_name.clone();
                        let title_clone = title.clone();
                        std::thread::spawn(move || {
                            if let Ok(item) = capture_game_screenshot_sync(&app_name_clone, &title_clone) {
                                let _ = app_clone.emit(
                                    "screenshot-captured",
                                    serde_json::json!({
                                        "id": app_name_clone,
                                        "title": title_clone,
                                        "item": item,
                                    }),
                                );
                            }
                        });
                    }
                }
            }

            was_down = is_down;
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn start_f12_listener(_app: AppHandle) {}

/// Ekran görüntüsü dosyasını siler.
#[tauri::command]
pub async fn epic_delete_game_screenshot(_app: AppHandle, file_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if p.exists() && p.is_file() {
            std::fs::remove_file(p).map(|_| true).map_err(|e| e.to_string())
        } else {
            Err("Dosya bulunamadı".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyunun ekran görüntüleri klasörünü Windows Explorer ile açar.
#[tauri::command]
pub async fn epic_open_game_screenshots_folder(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let clean_t = if !title.trim().is_empty() {
            clean_folder_name(&title)
        } else {
            clean_folder_name(&app_name)
        };
        let target_dir = game_screenshots_dir(&clean_t);
        let _ = std::fs::create_dir_all(&target_dir);

        // Kural 10: Klasör açma = Rust'tan explorer
        let _ = std::process::Command::new("explorer.exe")
            .arg(&target_dir)
            .spawn();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyun oynanırken alınan yeni ekran görüntülerini tespit edip taşır / bağlar.
pub fn scan_new_captures_for_game(clean_title: &str, start_time: std::time::SystemTime) -> Vec<PathBuf> {
    let mut added = Vec::new();
    let target_dir = game_screenshots_dir(clean_title);
    let _ = std::fs::create_dir_all(&target_dir);

    // 1. Pictures\Screenshots kontrolü
    let pic_ss = get_user_pictures_dir().join("Screenshots");
    if pic_ss.is_dir() {
        if let Ok(entries) = std::fs::read_dir(pic_ss) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(meta) = path.metadata() {
                    if meta.is_file() {
                        if let Ok(mod_time) = meta.modified() {
                            if mod_time >= start_time {
                                if let Some(name) = path.file_name() {
                                    let dest = target_dir.join(name);
                                    if !dest.exists() {
                                        if let Ok(_) = std::fs::copy(&path, &dest) {
                                            added.push(dest);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Videos\Captures kontrolü
    let vid_cap = get_user_videos_dir().join("Captures");
    if vid_cap.is_dir() {
        if let Ok(entries) = std::fs::read_dir(vid_cap) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(meta) = path.metadata() {
                    if meta.is_file() {
                        if let Ok(mod_time) = meta.modified() {
                            if mod_time >= start_time {
                                if let Some(name) = path.file_name() {
                                    let dest = target_dir.join(name);
                                    if !dest.exists() {
                                        if let Ok(_) = std::fs::copy(&path, &dest) {
                                            added.push(dest);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    added
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_folder_name() {
        assert_eq!(clean_folder_name("Dead by Daylight: Special Edition"), "Dead by Daylight Special Edition");
        assert_eq!(clean_folder_name("Tom Clancy's The Division / 2"), "Tom Clancy's The Division 2");
    }

    #[test]
    fn test_chrono_fallback() {
        // 1700000000 = 14.11.2023 22:13:20
        let date_str = chrono_fallback(1700000000);
        assert!(date_str.contains("2023"));
    }

    #[test]
    fn test_running_game_lifecycle() {
        set_active_running_game("Sugar", "Alan Wake 2");
        assert_eq!(get_active_running_game(), Some(("Sugar".to_string(), "Alan Wake 2".to_string())));
        clear_active_running_game("Sugar");
        assert_eq!(get_active_running_game(), None);
    }

    #[test]
    fn test_capture_screen_native() {
        #[cfg(target_os = "windows")]
        {
            let temp_file = std::env::temp_dir().join("efxlve_test_screen_capture.png");
            let _ = std::fs::remove_file(&temp_file);
            let start = std::time::Instant::now();
            let res = win_capture::capture_screen_native(&temp_file);
            let elapsed = start.elapsed();
            println!("Capture result: {:?}, took: {:?}", res, elapsed);
            if let Ok(()) = res {
                assert!(temp_file.exists(), "Captured screenshot file does not exist");
                let meta = temp_file.metadata().unwrap();
                println!("Captured file size: {} KB", meta.len() / 1024);
                assert!(meta.len() > 1000, "Screenshot file is too small (size: {})", meta.len());
                let _ = std::fs::remove_file(&temp_file);
            }
        }
    }
}
