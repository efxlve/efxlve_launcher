fn main() {
    link_discord_social_sdk();
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

/// Links the Discord Social SDK when its Windows drop is vendored locally
/// (`src-tauri/vendor/discord-sdk`, git-ignored: download it from the Developer
/// Portal → Social SDK → Downloads). The DLL is copied next to the executable
/// so the runtime finds it; without the folder the SDK code compiles out and
/// the build keeps working.
fn link_discord_social_sdk() {
    println!("cargo::rustc-check-cfg=cfg(discord_sdk)");
    let root = std::path::Path::new("vendor").join("discord-sdk");
    let lib_dir = root.join("lib").join("release");
    let dll = root.join("bin").join("release").join("discord_partner_sdk.dll");
    println!("cargo:rerun-if-changed={}", root.display());
    if !lib_dir.join("discord_partner_sdk.lib").exists() || !dll.exists() {
        println!("cargo:warning=Discord Social SDK not vendored; the SDK spike compiles out");
        return;
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=discord_partner_sdk");
    println!("cargo:rustc-cfg=discord_sdk");
    // The executable directory is three levels above OUT_DIR
    // (target/<profile>/build/<pkg>/out).
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let exe_dir = std::path::Path::new(&out_dir)
            .ancestors()
            .nth(3)
            .map(|dir| dir.to_path_buf());
        if let Some(dir) = exe_dir {
            let _ = std::fs::copy(&dll, dir.join("discord_partner_sdk.dll"));
            // The voice/noise models live next to the DLL; copy what is there.
            let krisp = root.join("bin").join("release").join("discord_krisp.dll");
            if krisp.exists() {
                let _ = std::fs::copy(&krisp, dir.join("discord_krisp.dll"));
            }
        }
    }
}
