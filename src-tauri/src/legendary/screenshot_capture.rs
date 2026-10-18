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
    fn SetStretchBltMode(hdc: HDC, mode: i32) -> i32;
    fn StretchBlt(
        hdc_dst: HDC,
        x_dst: i32,
        y_dst: i32,
        w_dst: i32,
        h_dst: i32,
        hdc_src: HDC,
        x_src: i32,
        y_src: i32,
        w_src: i32,
        h_src: i32,
        rop: u32,
    ) -> BOOL;
}

/// HALFTONE: the slow, good-looking downscale for `StretchBlt`.
const HALFTONE: i32 = 4;

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
    fn GdipSaveImageToStream(
        image: *mut c_void,
        stream: *mut c_void,
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
    fn GlobalLock(h: *mut c_void) -> *mut c_void;
    fn GlobalUnlock(h: *mut c_void) -> i32;
    fn GlobalSize(h: *mut c_void) -> usize;
}

#[link(name = "ole32")]
extern "system" {
    fn CreateStreamOnHGlobal(
        hglobal: *mut c_void,
        f_delete_on_release: i32,
        stream: *mut *mut c_void,
    ) -> i32;
    fn GetHGlobalFromStream(stream: *mut c_void, hglobal: *mut *mut c_void) -> i32;
}

/// GDI+'s JPEG quality knob: `EncoderQuality` = {1d5be4b5-fa4a-452d-9cdd-5db35105e7eb}.
const ENCODER_QUALITY: GUID = GUID {
    data1: 0x1d5be4b5,
    data2: 0xfa4a,
    data3: 0x452d,
    data4: [0x9c, 0xdd, 0x5d, 0xb3, 0x51, 0x05, 0xe7, 0xeb],
};

#[repr(C)]
struct EncoderParameter {
    guid: GUID,
    number_of_values: u32,
    type_: u32,
    value: *mut c_void,
}

#[repr(C)]
struct EncoderParameters {
    count: u32,
    parameter: [EncoderParameter; 1],
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

/// Releases a COM interface (`IUnknown::Release`, slot 2 of the vtable).
///
/// `CreateStreamOnHGlobal` hands back a stream that owns its HGLOBAL, so this
/// is what frees the frame buffer after the JPEG bytes are copied out.
unsafe fn com_release(interface: *mut c_void) {
    if interface.is_null() {
        return;
    }
    let vtable = *(interface as *const *const usize);
    if vtable.is_null() {
        return;
    }
    let release: extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(*vtable.add(2));
    release(interface);
}

/// One screen frame as JPEG bytes, for the clip recorder.
///
/// Same GDI recipe as `capture_screen_native` (kept separate on purpose: that
/// path is the proven one behind F12 and must not be disturbed), but the image
/// goes to an in-memory stream instead of a file, which is what makes 12 frames
/// a second affordable.
/// The frame size for a target height: keeps the aspect, never upscales, and
/// stays even (MJPEG encoders dislike odd edges). `target_height == 0` means
/// "native", which is the default.
pub fn scaled_size(width: i32, height: i32, target_height: u32) -> (i32, i32) {
    let target = target_height as i32;
    if target <= 0 || target >= height || width <= 0 || height <= 0 {
        return (width, height);
    }
    let scaled_width = ((width as f64) * (target as f64) / (height as f64)).round() as i32;
    (((scaled_width.max(2)) / 2) * 2, (target / 2) * 2)
}

pub fn capture_frame_jpeg(quality: u8, target_height: u32) -> Result<(Vec<u8>, u32, u32), String> {
    unsafe {
        let _ = SetProcessDPIAware();

        let h_desk = OpenInputDesktop(0, 0, 0x01FF);
        if !h_desk.is_null() {
            let _ = SetThreadDesktop(h_desk);
        }

        let hdc_screen = GetDC(std::ptr::null_mut());
        if hdc_screen.is_null() {
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("GetDC failed".to_string());
        }

        let mut width = GetDeviceCaps(hdc_screen, DESKTOPHORZRES);
        let mut height = GetDeviceCaps(hdc_screen, DESKTOPVERTRES);
        if width <= 0 || height <= 0 {
            width = GetSystemMetrics(0);
            height = GetSystemMetrics(1);
        }
        if width <= 0 || height <= 0 {
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("@t:ss.noResolution".to_string());
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_null() {
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("CreateCompatibleDC failed".to_string());
        }

        // The frame lands in a DIB at the target size; a smaller one is drawn by
        // StretchBlt straight from the screen, so no full-size buffer is kept.
        let (frame_width, frame_height) = scaled_size(width, height, target_height);
        let bmi = BITMAPINFO {
            bmi_header: BITMAPINFOHEADER {
                bi_size: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                bi_width: frame_width,
                bi_height: -frame_height,
                bi_planes: 1,
                bi_bit_count: 32,
                bi_compression: 0,
                bi_size_image: (frame_width * frame_height * 4) as u32,
                bi_xpels_per_meter: 0,
                bi_ypels_per_meter: 0,
                bi_clr_used: 0,
                bi_clr_important: 0,
            },
            bmi_colors: [0],
        };

        let mut ppv_bits: *mut c_void = std::ptr::null_mut();
        let h_bitmap = CreateDIBSection(hdc_mem, &bmi, 0, &mut ppv_bits, std::ptr::null_mut(), 0);
        if h_bitmap.is_null() {
            DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("CreateDIBSection failed".to_string());
        }

        let h_old = SelectObject(hdc_mem, h_bitmap);
        let blt_ok = if frame_width == width && frame_height == height {
            BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, SRCCOPY)
        } else {
            // HALFTONE is the slow, good-looking downscale; the recorder skips
            // frames rather than blocking on it.
            SetStretchBltMode(hdc_mem, HALFTONE);
            StretchBlt(
                hdc_mem,
                0,
                0,
                frame_width,
                frame_height,
                hdc_screen,
                0,
                0,
                width,
                height,
                SRCCOPY,
            )
        };
        SelectObject(hdc_mem, h_old);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);

        if blt_ok == 0 {
            DeleteObject(h_bitmap);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("BitBlt failed".to_string());
        }

        let startup_input = GdiplusStartupInput {
            gdiplus_version: 1,
            debug_event_callback: 0,
            suppress_background_thread: 0,
            suppress_external_codecs: 0,
        };
        let mut token: usize = 0;
        if GdiplusStartup(&mut token, &startup_input, std::ptr::null_mut()) != 0 {
            DeleteObject(h_bitmap);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("GdiplusStartup failed".to_string());
        }

        let mut gdip_image: *mut c_void = std::ptr::null_mut();
        let create_status =
            GdipCreateBitmapFromHBITMAP(h_bitmap, std::ptr::null_mut(), &mut gdip_image);
        if create_status != 0 || gdip_image.is_null() {
            DeleteObject(h_bitmap);
            GdiplusShutdown(token);
            if !h_desk.is_null() {
                CloseDesktop(h_desk);
            }
            return Err("GdipCreateBitmapFromHBITMAP failed".to_string());
        }

        // The quality parameter travels as an EncoderParameters block. A "Long"
        // value is four bytes: the encoder reads exactly that much.
        let mut quality_value: u32 = quality.clamp(10, 100) as u32;
        let params = EncoderParameters {
            count: 1,
            parameter: [EncoderParameter {
                guid: ENCODER_QUALITY,
                number_of_values: 1,
                type_: 4, // EncoderParameterValueTypeLong (1 is Byte: GDI+ refuses it)
                value: &mut quality_value as *mut u32 as *mut c_void,
            }],
        };

        let mut stream: *mut c_void = std::ptr::null_mut();
        let mut bytes: Result<Vec<u8>, String> = Err("CreateStreamOnHGlobal failed".to_string());
        let stream_status = CreateStreamOnHGlobal(std::ptr::null_mut(), 1, &mut stream);
        if stream_status == 0 && !stream.is_null() {
            let save_status = GdipSaveImageToStream(
                gdip_image,
                stream,
                &CLSID_JPEG,
                &params as *const EncoderParameters as *const c_void,
            );
            if save_status == 0 {
                let mut hglobal: *mut c_void = std::ptr::null_mut();
                let global_status = GetHGlobalFromStream(stream, &mut hglobal);
                if global_status == 0 && !hglobal.is_null() {
                    let size = GlobalSize(hglobal);
                    let ptr = GlobalLock(hglobal) as *const u8;
                    if !ptr.is_null() && size > 0 {
                        bytes = Ok(std::slice::from_raw_parts(ptr, size).to_vec());
                    } else {
                        bytes = Err(format!("GlobalLock/GlobalSize failed (size: {size})"));
                    }
                    let _ = GlobalUnlock(hglobal);
                } else {
                    bytes = Err(format!("GetHGlobalFromStream failed (0x{global_status:08X})"));
                }
            } else {
                bytes = Err(format!("GdipSaveImageToStream failed (status: {save_status})"));
            }
            // The stream owns the HGLOBAL (f_delete_on_release = 1), so releasing
            // the COM interface frees the memory.
            com_release(stream);
        }

        GdipDisposeImage(gdip_image);
        DeleteObject(h_bitmap);
        GdiplusShutdown(token);
        if !h_desk.is_null() {
            CloseDesktop(h_desk);
        }

        let bytes = bytes?;
        Ok((bytes, frame_width as u32, frame_height as u32))
    }
}

#[cfg(test)]
mod scale_tests {
    use super::scaled_size;

    #[test]
    fn a_target_keeps_the_aspect_and_never_upscales() {
        // 2560x1600 to 1080p.
        assert_eq!(scaled_size(2560, 1600, 1080), (1728, 1080));
        // 1440p from a 1600-tall screen: 1440 is allowed.
        assert_eq!(scaled_size(2560, 1600, 1440), (2304, 1440));
        // Never upscale.
        assert_eq!(scaled_size(1920, 1080, 2160), (1920, 1080));
        // Native.
        assert_eq!(scaled_size(2560, 1600, 0), (2560, 1600));
        // Odd results are rounded down to even numbers.
        let (w, h) = scaled_size(1921, 1081, 720);
        assert_eq!(h % 2, 0);
        assert_eq!(w % 2, 0);
    }
}
