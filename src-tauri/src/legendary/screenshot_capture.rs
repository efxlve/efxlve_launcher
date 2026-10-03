//! Windows screen capture for the running game.
//!
//! GDI plus the desktop DC. The parent module decides the file name and folder.

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

// CLSID for ImageFormatJPEG: {557cf401-1a04-11d3-9a73-0000f81ef32e}
const CLSID_JPEG: GUID = GUID {
    data1: 0x557cf401,
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
    fn GdiplusStartup(
        token: *mut usize,
        input: *const GdiplusStartupInput,
        output: *mut c_void,
    ) -> i32;
    fn GdiplusShutdown(token: usize);
    fn GdipCreateBitmapFromHBITMAP(
        hbm: HBITMAP,
        hpal: *mut c_void,
        bitmap: *mut *mut c_void,
    ) -> i32;
    fn GdipSaveImageToFile(
        image: *mut c_void,
        filename: *const u16,
        clsidEncoder: *const GUID,
        encoderParams: *const c_void,
    ) -> i32;
    fn GdipDisposeImage(image: *mut c_void) -> i32;
    fn GdipLoadImageFromFile(filename: *const u16, image: *mut *mut c_void) -> i32;
    fn GdipGetImageWidth(image: *mut c_void, width: *mut u32) -> i32;
    fn GdipGetImageHeight(image: *mut c_void, height: *mut u32) -> i32;
    fn GdipGetImageThumbnail(
        image: *mut c_void,
        thumb_width: u32,
        thumb_height: u32,
        thumb_image: *mut *mut c_void,
        callback: *mut c_void,
        callback_data: *mut c_void,
    ) -> i32;
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
            return Err(format!(
                "CreateCompatibleDC failed (err: {})",
                GetLastError()
            ));
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
        let blt_ok = BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, SRCCOPY);
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
        let create_status =
            GdipCreateBitmapFromHBITMAP(h_bitmap, std::ptr::null_mut(), &mut gdip_image);

        DeleteObject(h_bitmap);

        if create_status != 0 || gdip_image.is_null() {
            GdiplusShutdown(token);
            return Err(format!(
                "GdipCreateBitmapFromHBITMAP failed (status: {})",
                create_status
            ));
        }

        let wide_path: Vec<u16> = target_file
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let save_status =
            GdipSaveImageToFile(gdip_image, wide_path.as_ptr(), &CLSID_PNG, std::ptr::null());

        GdipDisposeImage(gdip_image);
        GdiplusShutdown(token);

        if !h_desk.is_null() {
            CloseDesktop(h_desk);
        }

        if save_status != 0 {
            return Err(format!(
                "GdipSaveImageToFile failed (status: {})",
                save_status
            ));
        }

        Ok(())
    }
}

/// Writes a small JPEG preview of `source` to `target` for the gallery grid.
///
/// The gallery used to ship every capture as a full-size data URL in one IPC
/// response; a folder of 4K PNGs turns that into hundreds of megabytes across
/// the Rust, JSON and WebView copies. The preview keeps the listing small, and
/// the original is read only when the lightbox, share sheet or compressor asks
/// for it.
pub fn make_thumbnail(source: &Path, target: &Path, max_px: u32) -> Result<(), String> {
    unsafe {
        let startup_input = GdiplusStartupInput {
            gdiplus_version: 1,
            debug_event_callback: 0,
            suppress_background_thread: 0,
            suppress_external_codecs: 0,
        };

        let mut token: usize = 0;
        let status = GdiplusStartup(&mut token, &startup_input, std::ptr::null_mut());
        if status != 0 {
            return Err(format!("GdiplusStartup failed (status: {})", status));
        }

        let result = make_thumbnail_gdi(source, target, max_px);
        GdiplusShutdown(token);
        result
    }
}

unsafe fn make_thumbnail_gdi(source: &Path, target: &Path, max_px: u32) -> Result<(), String> {
    let wide_source: Vec<u16> = source
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut image: *mut c_void = std::ptr::null_mut();
    let load_status = GdipLoadImageFromFile(wide_source.as_ptr(), &mut image);
    if load_status != 0 || image.is_null() {
        return Err(format!(
            "GdipLoadImageFromFile failed (status: {})",
            load_status
        ));
    }

    let mut width: u32 = 0;
    let mut height: u32 = 0;
    let _ = GdipGetImageWidth(image, &mut width);
    let _ = GdipGetImageHeight(image, &mut height);
    if width == 0 || height == 0 {
        GdipDisposeImage(image);
        return Err("Image reports no size".to_string());
    }

    // GdipGetImageThumbnail stretches to the box it is given; compute the box
    // from the aspect ratio instead.
    let scale = max_px as f64 / width.max(height) as f64;
    let thumb_w = ((width as f64 * scale).round() as u32).max(1);
    let thumb_h = ((height as f64 * scale).round() as u32).max(1);

    let mut thumb: *mut c_void = std::ptr::null_mut();
    let thumb_status = GdipGetImageThumbnail(
        image,
        thumb_w,
        thumb_h,
        &mut thumb,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    GdipDisposeImage(image);
    if thumb_status != 0 || thumb.is_null() {
        return Err(format!(
            "GdipGetImageThumbnail failed (status: {})",
            thumb_status
        ));
    }

    let wide_target: Vec<u16> = target
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let save_status = GdipSaveImageToFile(thumb, wide_target.as_ptr(), &CLSID_JPEG, std::ptr::null());
    GdipDisposeImage(thumb);

    if save_status != 0 {
        return Err(format!(
            "GdipSaveImageToFile failed (status: {})",
            save_status
        ));
    }
    Ok(())
}
