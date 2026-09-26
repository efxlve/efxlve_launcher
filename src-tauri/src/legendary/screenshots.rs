use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
struct RunningGame {
    app_name: String,
    title: String,
    install_path: Option<PathBuf>,
    exes: Vec<String>,
}

static RUNNING_GAME: RwLock<Option<RunningGame>> = RwLock::new(None);
static CAPTURE_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_active_running_game(
    app_name: &str,
    title: &str,
    install_path: Option<PathBuf>,
    exes: Vec<String>,
) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        *g = Some(RunningGame {
            app_name: app_name.to_string(),
            title: title.to_string(),
            install_path,
            exes,
        });
    }
}

/// True only when the foreground window belongs to the running game, not the launcher.
fn game_window_is_foreground() -> bool {
    let game = match RUNNING_GAME.read() {
        Ok(g) => (*g).clone(),
        Err(_) => return false,
    };
    let Some(game) = game else {
        return false;
    };
    let pids = super::transfers::game_process_pids(game.install_path.as_deref(), &game.exes);
    if pids.is_empty() {
        return false;
    }
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetForegroundWindow() -> *mut std::ffi::c_void;
            fn GetWindowThreadProcessId(hwnd: *mut std::ffi::c_void, pid: *mut u32) -> u32;
        }
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            pids.contains(&pid)
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn clear_active_running_game(app_name: &str) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        if let Some(cur) = g.as_ref() {
            if cur.app_name == app_name {
                *g = None;
            }
        }
    }
}

pub fn get_active_running_game() -> Option<(String, String)> {
    RUNNING_GAME
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|g| (g.app_name.clone(), g.title.clone())))
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

/// User-configured screenshots root. `None` keeps the legacy
/// `%USERPROFILE%\Pictures\Efxlve Screenshots` layout.
static SCREENSHOT_ROOT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Stores the configured root for this session (called at startup and on save).
pub fn set_screenshot_root(root: Option<String>) {
    let cleaned = root
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    if let Ok(mut slot) = SCREENSHOT_ROOT.lock() {
        *slot = cleaned;
    }
}

fn configured_screenshot_root() -> Option<PathBuf> {
    SCREENSHOT_ROOT.lock().ok().and_then(|slot| slot.clone())
}

/// Pure resolver: the configured folder wins, otherwise the Pictures default.
/// Kept pure so the fallback rule is unit-testable without session state.
pub fn resolve_screenshot_root(configured: Option<&Path>) -> PathBuf {
    match configured {
        Some(path) => path.to_path_buf(),
        None => get_user_pictures_dir().join("Efxlve Screenshots"),
    }
}

/// Root that holds one screenshot folder per game.
pub fn screenshots_root() -> PathBuf {
    resolve_screenshot_root(configured_screenshot_root().as_deref())
}

pub fn game_screenshots_dir(clean_title: &str) -> PathBuf {
    screenshots_root().join(clean_title)
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
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct SYSTEMTIME {
    pub w_year: u16,
    pub w_month: u16,
    pub w_day_of_week: u16,
    pub w_day: u16,
    pub w_hour: u16,
    pub w_minute: u16,
    pub w_second: u16,
    pub w_milliseconds: u16,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct FILETIME {
    pub dw_low_date_time: u32,
    pub dw_high_date_time: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetLocalTime(lpSystemTime: *mut SYSTEMTIME);
    fn FileTimeToLocalFileTime(lpFileTime: *const FILETIME, lpLocalFileTime: *mut FILETIME) -> i32;
    fn FileTimeToSystemTime(lpFileTime: *const FILETIME, lpSystemTime: *mut SYSTEMTIME) -> i32;
}

pub fn get_local_now_systemtime() -> SYSTEMTIME {
    #[cfg(target_os = "windows")]
    unsafe {
        let mut st = SYSTEMTIME::default();
        GetLocalTime(&mut st);
        st
    }
    #[cfg(not(target_os = "windows"))]
    SYSTEMTIME::default()
}

pub fn get_file_local_datetime_str(_path: &Path, metadata: &std::fs::Metadata, epoch_sec: u64) -> String {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        let ft_u64 = metadata.last_write_time();
        let ft_utc = FILETIME {
            dw_low_date_time: (ft_u64 & 0xFFFFFFFF) as u32,
            dw_high_date_time: (ft_u64 >> 32) as u32,
        };
        let mut ft_local = FILETIME::default();
        let mut st = SYSTEMTIME::default();
        unsafe {
            if FileTimeToLocalFileTime(&ft_utc, &mut ft_local) != 0
                && FileTimeToSystemTime(&ft_local, &mut st) != 0
            {
                return format!(
                    "{:02}.{:02}.{:04} {:02}:{:02}:{:02}",
                    st.w_day, st.w_month, st.w_year, st.w_hour, st.w_minute, st.w_second
                );
            }
        }
    }
    chrono_fallback(epoch_sec)
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
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "avif") {
        return None;
    }

    let file_name = path.file_name()?.to_string_lossy().to_string();
    let size_bytes = metadata.len();
    let size_str = format_bytes(size_bytes);

    let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let duration = modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let timestamp = duration.as_secs();

    // Get Windows' real local file time and date (local timezone instead of UTC)
    let datetime = get_file_local_datetime_str(path, &metadata, timestamp);
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
    let days_since_epoch = epoch_sec / 86400;
    let day_sec = epoch_sec % 86400;
    let hours = (day_sec / 3600) % 24;
    let minutes = (day_sec / 60) % 60;
    let seconds = day_sec % 60;

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
    format!("{:02}.{:02}.{:04} {:02}:{:02}:{:02}", day, month, year, hours, minutes, seconds)
}

/// Scans and returns all of a game's screenshots from disk.
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

        // 1. Per-game folders: the configured root plus the legacy default so
        // screenshots taken before a folder change stay visible.
        let legacy_root = get_user_pictures_dir().join("Efxlve Screenshots");
        let dirs_to_check = vec![
            game_screenshots_dir(&clean_t),
            game_screenshots_dir(&clean_app),
            legacy_root.join(&clean_t),
            legacy_root.join(&clean_app),
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

        // 2. Windows Game Bar / Captures folder: %USERPROFILE%\Videos\Captures
        let captures_dir = get_user_videos_dir().join("Captures");
        if captures_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&captures_dir) {
                let lower_title = clean_t.to_lowercase();
                let lower_app = clean_app.to_lowercase();
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                    // Match when the file name contains the game title or app_name
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

        // Sort newest to oldest
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

            // Attach to the active (input) desktop - prevents BitBlt from returning ERROR_INVALID_HANDLE
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
                return Err("@t:ss.noResolution".to_string());
            }

            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(format!("CreateCompatibleDC failed (err: {})", GetLastError()));
            }

            // Allocate a high-resolution bitmap with CreateDIBSection without a memory-pool limit
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

            // 4. Save directly as PNG at native C speed via GDI+ (~15 ms)
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

/// Synchronously captures the primary screen and saves it to the running game's folder.
/// Refuses when no game is running, and ignores a second request while one capture is in flight.
pub fn capture_game_screenshot_sync(app_name: &str, title: &str) -> Result<GameScreenshotItem, String> {
    let Some((running_app, running_title)) = get_active_running_game() else {
        return Err("@t:ss.notInGame".to_string());
    };
    if !app_name.is_empty() && app_name != running_app {
        return Err("@t:ss.notInGame".to_string());
    }
    if !game_window_is_foreground() {
        return Err("@t:ss.notInGame".to_string());
    }
    if CAPTURE_BUSY.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("@t:ss.busy".to_string());
    }
    let _ = title;
    struct ReleaseCapture;
    impl Drop for ReleaseCapture {
        fn drop(&mut self) {
            CAPTURE_BUSY.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _guard = ReleaseCapture;
    capture_screen_to_game_folder(&running_app, &running_title)
}

fn capture_screen_to_game_folder(app_name: &str, title: &str) -> Result<GameScreenshotItem, String> {
    let clean_t = if !title.trim().is_empty() {
        clean_folder_name(title)
    } else {
        clean_folder_name(app_name)
    };
    let target_dir = game_screenshots_dir(&clean_t);
    let _ = std::fs::create_dir_all(&target_dir);

    let st = get_local_now_systemtime();
    let file_name = if st.w_year >= 2020 {
        format!(
            "{}_{:04}-{:02}-{:02}_{:02}-{:02}-{:02}_{:03}.png",
            clean_t.replace(' ', "_"),
            st.w_year,
            st.w_month,
            st.w_day,
            st.w_hour,
            st.w_minute,
            st.w_second,
            st.w_milliseconds
        )
    } else {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}_Screenshot_{}.png", clean_t.replace(' ', "_"), timestamp)
    };
    let target_file = target_dir.join(&file_name);

    // 1. Try native Win32 GDI + GDI+ first (< 20 ms, full physical resolution)
    let native_res = win_capture::capture_screen_native(&target_file);

    if native_res.is_err() {
        // 2. Fallback: DPI-aware PowerShell command (full 2560x1600 resolution)
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

        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-EncodedCommand")
            .arg(&encoded_cmd);
        cmd.creation_flags(0x08000000);
        let _ = cmd.status();

        if !target_file.exists() {
            return Err(format!(
                "@t:ss.captureFailedNative\u{1f}{:?}",
                native_res.err()
            ));
        }
    }

    parse_file_to_item(&target_file).ok_or_else(|| "@t:ss.fileReadFailed".to_string())
}

/// Captures a screenshot and saves it to the game's folder.
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

static SCREENSHOT_HOTKEY: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0x7B);

/// Updates the screenshot hotkey (default: 0x7B = VK_F12).
#[tauri::command]
pub fn epic_set_screenshot_hotkey(vkey: i32) {
    if vkey > 0 {
        SCREENSHOT_HOTKEY.store(vkey, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Returns the active screenshot hotkey virtual key code.
#[tauri::command]
pub fn epic_get_screenshot_hotkey() -> i32 {
    SCREENSHOT_HOTKEY.load(std::sync::atomic::Ordering::Relaxed)
}

/// Background listener that captures a screenshot when the hotkey (default F12) is pressed while a game is running.
#[cfg(target_os = "windows")]
pub fn start_f12_listener(app: AppHandle) {
    std::thread::spawn(move || {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(vKey: i32) -> i16;
        }

        let mut was_down = false;
        let mut last_capture_time = std::time::Instant::now() - std::time::Duration::from_secs(10);

        loop {
            // Only check the hotkey while a game is actively running
            let running = get_active_running_game();
            if running.is_none() || !game_window_is_foreground() {
                was_down = false;
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            }

            std::thread::sleep(std::time::Duration::from_millis(20));

            let hotkey = SCREENSHOT_HOTKEY.load(std::sync::atomic::Ordering::Relaxed);
            let state = unsafe { GetAsyncKeyState(hotkey) };
            let is_down = (state as u16 & 0x8000) != 0;

            if is_down && !was_down {
                // Hotkey pressed! (key-down edge)
                if last_capture_time.elapsed() >= std::time::Duration::from_millis(400) {
                    last_capture_time = std::time::Instant::now();
                    if let Some((app_name, title)) = running {
                        // 1. IMMEDIATE SHUTTER TRIGGER (shutter sound and UI notice with 0 ms delay)
                        let _ = app.emit(
                            "screenshot-shutter",
                            serde_json::json!({
                                "id": app_name,
                                "title": title,
                            }),
                        );

                        // 2. Hardware screenshot capture in the background (< 110 ms)
                        let app_clone = app.clone();
                        let app_name_clone = app_name.clone();
                        let title_clone = title.clone();
                        std::thread::spawn(move || {
                            // A busy capture is dropped; the previous one is still writing.
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

/// Replaces the original screenshot with a compressed image (AVIF / WebP / JPEG).
/// On success it removes the original raw file and returns the new file.
#[tauri::command]
pub async fn epic_replace_screenshot_with_compressed(
    _app: AppHandle,
    original_path: String,
    compressed_base64: String,
    new_ext: String,
) -> Result<GameScreenshotItem, String> {
    tokio::task::spawn_blocking(move || {
        let orig = Path::new(&original_path);
        if !orig.exists() || !orig.is_file() {
            return Err("@t:ss.originalNotFound".to_string());
        }

        let clean_b64 = if let Some(idx) = compressed_base64.find(',') {
            &compressed_base64[idx + 1..]
        } else {
            &compressed_base64
        };

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(clean_b64)
            .map_err(|e| format!("@t:ss.base64Failed\u{1f}{e}"))?;

        if bytes.is_empty() {
            return Err("@t:ss.emptyData".to_string());
        }

        let clean_ext = new_ext.trim().trim_start_matches('.').to_lowercase();
        let valid_ext = match clean_ext.as_str() {
            "avif" => "avif",
            "webp" => "webp",
            "jpg" | "jpeg" => "jpg",
            _ => "avif",
        };

        let parent_dir = orig.parent().unwrap_or_else(|| Path::new("."));
        let file_stem = orig.file_stem().and_then(|s| s.to_str()).unwrap_or("screenshot");
        let new_file_name = format!("{}.{}", file_stem, valid_ext);
        let new_path = parent_dir.join(&new_file_name);

        std::fs::write(&new_path, &bytes)
            .map_err(|e| format!("@t:ss.writeCompressedFailed\u{1f}{e}"))?;

        // Clean up the old raw file if it has a different extension (e.g. .png -> .avif)
        if new_path != orig && orig.exists() {
            let _ = std::fs::remove_file(orig);
        }

        parse_file_to_item(&new_path).ok_or_else(|| "@t:ss.compressedReadFailed".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a screenshot file.
#[tauri::command]
pub async fn epic_delete_game_screenshot(_app: AppHandle, file_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if p.exists() && p.is_file() {
            std::fs::remove_file(p).map(|_| true).map_err(|e| e.to_string())
        } else {
            Err("@t:ss.fileNotFound".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the game's screenshots folder with Windows Explorer.
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

        // Rule 10: opening a folder = explorer from Rust
        let _ = std::process::Command::new("explorer.exe")
            .arg(&target_dir)
            .spawn();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Effective screenshots root (configured folder or the Pictures default).
#[tauri::command]
pub fn epic_get_screenshot_dir(app: AppHandle) -> String {
    set_screenshot_root(crate::load_settings(&app).screenshot_dir);
    screenshots_root().to_string_lossy().to_string()
}

/// Files and bytes currently stored in the effective screenshots root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotMoveInfo {
    pub count: u32,
    pub bytes: u64,
    pub dir: String,
}

/// Outcome of a screenshots root change (`skipped` = target file already existed).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotDirResult {
    pub dir: String,
    pub moved: u32,
    pub skipped: u32,
}

/// Counts screenshot files directly under `root` and inside its game folders.
fn count_screenshots_in(root: &Path) -> (u32, u64) {
    let mut count = 0u32;
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(files) = std::fs::read_dir(&path) {
                for file in files.flatten() {
                    let file_path = file.path();
                    if file_path.is_file() {
                        count += 1;
                        bytes += file_path.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
        } else if path.is_file() {
            count += 1;
            bytes += path.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (count, bytes)
}

/// Moves one file; falls back to copy + delete when the target is on another drive.
fn move_file_to(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    std::fs::remove_file(from).map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves every screenshot from `old_root` into `new_root`, keeping the per-game
/// folder layout. Files that already exist at the target are left untouched.
fn move_screenshots(old_root: &Path, new_root: &Path) -> Result<(u32, u32), String> {
    if !old_root.is_dir() || old_root == new_root {
        return Ok((0, 0));
    }
    std::fs::create_dir_all(new_root).map_err(|e| e.to_string())?;
    let mut moved = 0u32;
    let mut skipped = 0u32;
    let entries = std::fs::read_dir(old_root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let dest_dir = new_root.join(entry.file_name());
            let files = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
            for file in files.flatten() {
                let file_path = file.path();
                if !file_path.is_file() {
                    continue;
                }
                let target = dest_dir.join(file.file_name());
                if target.exists() {
                    skipped += 1;
                    continue;
                }
                move_file_to(&file_path, &target)?;
                moved += 1;
            }
        } else if path.is_file() {
            let target = new_root.join(entry.file_name());
            if target.exists() {
                skipped += 1;
                continue;
            }
            move_file_to(&path, &target)?;
            moved += 1;
        }
    }
    Ok((moved, skipped))
}

/// Stats for the "move existing screenshots?" confirmation.
#[tauri::command]
pub fn epic_get_screenshot_move_info(app: AppHandle) -> ScreenshotMoveInfo {
    set_screenshot_root(crate::load_settings(&app).screenshot_dir);
    let root = screenshots_root();
    let (count, bytes) = count_screenshots_in(&root);
    ScreenshotMoveInfo {
        count,
        bytes,
        dir: root.to_string_lossy().to_string(),
    }
}

/// Opens the effective screenshots root, creating it when missing.
#[tauri::command]
pub fn epic_open_screenshot_dir(app: AppHandle) -> Result<String, String> {
    set_screenshot_root(crate::load_settings(&app).screenshot_dir);
    let root = screenshots_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("@t:ss.dirCreateFailed\u{1f}{e}"))?;
    #[cfg(windows)]
    let res = std::process::Command::new("explorer").arg(&root).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&root).spawn();
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(&root).spawn();
    res.map(|_| "@t:win.folderOpened".to_string())
        .map_err(|e| format!("@t:win.folderOpenFailed\u{1f}{e}"))
}

/// Saves the screenshots root (`None` = default). With `move_existing`, the
/// files from the previous root are moved into the new one first.
#[tauri::command]
pub fn epic_set_screenshot_dir(
    app: AppHandle,
    path: Option<String>,
    move_existing: Option<bool>,
) -> Result<ScreenshotDirResult, String> {
    let cleaned = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(dir) = &cleaned {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("@t:ss.dirCreateFailed\u{1f}{e}"))?;
    }
    let old_root = screenshots_root();
    let new_root = resolve_screenshot_root(cleaned.as_deref().map(Path::new));
    let mut moved = 0u32;
    let mut skipped = 0u32;
    if move_existing.unwrap_or(false) && old_root != new_root {
        let (m, s) = move_screenshots(&old_root, &new_root)
            .map_err(|e| format!("@t:ss.moveFailed\u{1f}{e}"))?;
        moved = m;
        skipped = s;
    }
    let mut settings = crate::load_settings(&app);
    settings.screenshot_dir = cleaned;
    crate::save_settings(&app, &settings);
    set_screenshot_root(settings.screenshot_dir.clone());
    Ok(ScreenshotDirResult {
        dir: new_root.to_string_lossy().to_string(),
        moved,
        skipped,
    })
}

/// Detects new screenshots taken during play and moves / links them.
pub fn scan_new_captures_for_game(clean_title: &str, start_time: std::time::SystemTime) -> Vec<PathBuf> {
    let mut added = Vec::new();
    let target_dir = game_screenshots_dir(clean_title);
    let _ = std::fs::create_dir_all(&target_dir);

    // 1. Pictures\Screenshots check
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

    // 2. Videos\Captures check
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
    fn screenshot_root_prefers_configured_folder() {
        let custom = Path::new(r"D:\Captures");
        assert_eq!(resolve_screenshot_root(Some(custom)), PathBuf::from(custom));
        assert_eq!(resolve_screenshot_root(Some(custom)).join("Game"), PathBuf::from(r"D:\Captures").join("Game"));
        // No configured folder: the legacy Pictures root stays the default.
        assert!(resolve_screenshot_root(None).ends_with("Efxlve Screenshots"));
    }

    #[test]
    fn move_screenshots_keeps_game_folders_and_skips_existing_files() {
        let base = std::env::temp_dir().join(format!("efxlve-ss-move-{}", std::process::id()));
        let old = base.join("old");
        let new = base.join("new");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(old.join("Game A")).unwrap();
        std::fs::create_dir_all(old.join("Game B")).unwrap();
        std::fs::create_dir_all(new.join("Game B")).unwrap();
        std::fs::write(old.join("Game A").join("a1.png"), b"a1").unwrap();
        std::fs::write(old.join("Game A").join("a2.png"), b"a2").unwrap();
        std::fs::write(old.join("Game B").join("b1.png"), b"b1").unwrap();
        std::fs::write(new.join("Game B").join("b1.png"), b"already").unwrap();
        std::fs::write(old.join("loose.png"), b"loose").unwrap();

        let (count, bytes) = count_screenshots_in(&old);
        assert_eq!(count, 4);
        assert!(bytes > 0);

        let (moved, skipped) = move_screenshots(&old, &new).unwrap();
        assert_eq!((moved, skipped), (3, 1));
        assert!(new.join("Game A").join("a1.png").is_file());
        assert!(new.join("Game A").join("a2.png").is_file());
        assert!(new.join("loose.png").is_file());
        // An existing target file is never overwritten.
        assert_eq!(std::fs::read(new.join("Game B").join("b1.png")).unwrap(), b"already");
        assert!(!old.join("Game A").join("a1.png").exists());
        // The same root is a no-op even when "move" was requested.
        assert_eq!(move_screenshots(&new, &new).unwrap(), (0, 0));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_chrono_fallback() {
        // 1700000000 = 14.11.2023 22:13:20
        let date_str = chrono_fallback(1700000000);
        assert!(date_str.contains("2023"));
    }

    #[test]
    fn test_running_game_lifecycle() {
        set_active_running_game("Sugar", "Alan Wake 2", None, Vec::new());
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

    #[test]
    fn test_local_systemtime_and_file_time() {
        let st = get_local_now_systemtime();
        println!("Local system time: {:04}-{:02}-{:02} {:02}:{:02}:{:02}", st.w_year, st.w_month, st.w_day, st.w_hour, st.w_minute, st.w_second);
        #[cfg(target_os = "windows")]
        {
            assert!(st.w_year >= 2026);
            assert!(st.w_month >= 1 && st.w_month <= 12);
            assert!(st.w_day >= 1 && st.w_day <= 31);
        }
    }

    #[test]
    fn test_file_local_datetime_str() {
        let temp_file = std::env::temp_dir().join("efxlve_test_time.png");
        std::fs::write(&temp_file, b"fake png data").unwrap();
        let meta = temp_file.metadata().unwrap();
        let dt_str = get_file_local_datetime_str(&temp_file, &meta, 1789859000);
        println!("File local datetime str: {}", dt_str);
        #[cfg(target_os = "windows")]
        {
            assert!(dt_str.contains("2026"));
        }
        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_screenshot_hotkey_set_and_get() {
        epic_set_screenshot_hotkey(0x7A); // F11
        assert_eq!(epic_get_screenshot_hotkey(), 0x7A);
        epic_set_screenshot_hotkey(0x7B); // F12 (reset)
        assert_eq!(epic_get_screenshot_hotkey(), 0x7B);
    }

    #[test]
    fn test_avif_parsing_and_mime() {
        let temp_file = std::env::temp_dir().join("efxlve_test_avif.avif");
        std::fs::write(&temp_file, b"fake avif byte content").unwrap();
        let item = parse_file_to_item(&temp_file);
        assert!(item.is_some(), "AVIF file should be parsed to item");
        let unwrapped = item.unwrap();
        assert!(unwrapped.data_url.starts_with("data:image/avif;base64,"));
        let _ = std::fs::remove_file(&temp_file);
    }
}
