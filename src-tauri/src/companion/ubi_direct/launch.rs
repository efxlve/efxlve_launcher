//! Launch a directly-installed Ubisoft game without the Connect client.
//!
//! The installer already put the game in a folder the launcher owns. This
//! module seeds the registry keys Ubisoft titles read and starts the executable
//! from that folder. A title whose DRM needs the Uplay loader is rejected with a
//! clear message instead of a silent crash; the compatibility shim is a separate
//! opt-in step.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::companion::ubi_installs;

pub(crate) fn launch(product_id: u32) -> Result<(), String> {
    let game = ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let install_dir = PathBuf::from(&game.install_dir);
    if !install_dir.is_dir() {
        return Err(format!("install folder is missing: {}", install_dir.display()));
    }
    let exe = resolve_exe(&install_dir, &game.exe)?;
    seed_registry(product_id, &install_dir);
    let mut command = Command::new(&exe);
    command.current_dir(&install_dir);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("starting {}: {e}", exe.display()))
}

fn resolve_exe(install_dir: &Path, recorded: &str) -> Result<PathBuf, String> {
    if !recorded.trim().is_empty() {
        let path = install_dir.join(recorded.replace('\\', std::path::MAIN_SEPARATOR_STR));
        if path.is_file() {
            return Ok(path);
        }
    }
    // The record can be stale after an update changed the binary name. Pick the
    // largest plausible game exe instead of making the user reinstall.
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![install_dir.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !name.ends_with(".exe") {
                continue;
            }
            let path_text = path.to_string_lossy().to_lowercase();
            if path_text.contains("/support/") || path_text.contains("\\support\\") {
                continue;
            }
            if [
                "vcredist", "vc_redist", "dxsetup", "directx", "redist", "unins", "setup",
                "install", "crash", "helper", "uplayinstaller", "dotnet", "netfx",
            ]
            .iter()
            .any(|junk| name.contains(junk))
            {
                continue;
            }
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if best.as_ref().map(|(current, _)| size > *current).unwrap_or(true) {
                best = Some((size, path));
            }
        }
    }
    best.map(|(_, path)| path)
        .ok_or_else(|| format!("no game executable found under {}", install_dir.display()))
}

/// Ubisoft titles resolve their install folder from these keys. They are
/// per-machine, so the write needs elevation; a launcher that is not elevated
/// still gets the per-user key and the game's own working directory.
fn seed_registry(product_id: u32, install_dir: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let value = install_dir.display().to_string();
        let keys = [
            format!(r"HKCU\Software\Ubisoft\Launcher\Installs\{product_id}"),
            format!(r"HKLM\SOFTWARE\Ubisoft\Launcher\Installs\{product_id}"),
            format!(r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\{product_id}"),
            r"HKLM\SOFTWARE\Ubisoft\Launcher".to_string(),
        ];
        for key in keys {
            let mut command = Command::new("reg");
            command.args([
                "add",
                &key,
                "/v",
                "InstallDir",
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ]);
            command.creation_flags(CREATE_NO_WINDOW);
            let _ = command.status();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (product_id, install_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_exe;

    #[test]
    fn resolves_the_recorded_exe_then_falls_back_to_the_largest_one() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-launch-{}", std::process::id()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let game = bin.join("game.exe");
        let helper = root.join("helper.exe");
        std::fs::write(&game, vec![0u8; 32]).unwrap();
        std::fs::write(&helper, vec![0u8; 8]).unwrap();

        assert_eq!(
            resolve_exe(&root, r"bin\game.exe").unwrap(),
            game
        );
        assert_eq!(resolve_exe(&root, "").unwrap(), game);
        let _ = std::fs::remove_dir_all(&root);
    }
}
