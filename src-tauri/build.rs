fn main() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = std::process::Command::new("taskkill")
                .args(["/IM", "efxlve-launcher.exe", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    tauri_build::build()
}
