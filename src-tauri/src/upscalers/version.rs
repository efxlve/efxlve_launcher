//! DLL file version and Authenticode helpers.
//!
//! The version comes from the PE version resource, the same source DLSS
//! Swapper reads. Catalog downloads must also carry a trusted Authenticode
//! signature before they are allowed into a game folder.

use std::path::Path;

/// Formats the two fixed 16-bit version words as `a.b.c.d`.
pub fn format_fixed_version(ms: u32, ls: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        (ms >> 16) & 0xffff,
        ms & 0xffff,
        (ls >> 16) & 0xffff,
        ls & 0xffff
    )
}

#[cfg(windows)]
pub fn file_version(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
        VS_FFI_SIGNATURE,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    unsafe {
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, buffer.as_mut_ptr().cast()).ok()?;
    }

    let sub_block: Vec<u16> = "\\".encode_utf16().chain(std::iter::once(0)).collect();
    let mut pointer: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut length = 0u32;
    let found = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            PCWSTR(sub_block.as_ptr()),
            &mut pointer,
            &mut length,
        )
    };
    if !found.as_bool()
        || pointer.is_null()
        || length < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return None;
    }
    let info = unsafe { &*(pointer as *const VS_FIXEDFILEINFO) };
    if info.dwSignature as i32 != VS_FFI_SIGNATURE {
        return None;
    }
    Some(format_fixed_version(
        info.dwFileVersionMS,
        info.dwFileVersionLS,
    ))
}

#[cfg(not(windows))]
pub fn file_version(_path: &Path) -> Option<String> {
    None
}

/// True when Windows trusts the embedded Authenticode signature.
#[cfg(windows)]
pub fn verify_signature(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        hFile: Default::default(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    // The union member is only valid after dwUnionChoice selects the file.
    data.Anonymous.pFile = &mut file_info;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            HWND::default(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        let _ = WinVerifyTrust(
            HWND::default(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
    }
    status == 0
}

#[cfg(not(windows))]
pub fn verify_signature(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::format_fixed_version;

    #[test]
    fn version_words_are_split_in_order() {
        assert_eq!(
            format_fixed_version((310 << 16) | 9, (16 << 16) | 0),
            "310.9.16.0"
        );
        assert_eq!(format_fixed_version(1, (2 << 16) | 38022), "0.1.2.38022");
    }
}
