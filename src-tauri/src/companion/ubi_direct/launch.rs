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

use super::shim;

pub(crate) async fn launch(product_id: u32, shim_enabled: bool) -> Result<(), String> {
    let game = ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let install_dir = PathBuf::from(&game.install_dir);
    if !install_dir.is_dir() {
        return Err(format!("install folder is missing: {}", install_dir.display()));
    }
    let exe = resolve_exe(&install_dir, &game.exe)?;
    seed_registry(product_id, &install_dir);
    seed_game_registry(&game, &install_dir);

    if shim_enabled {
        let account = shim_account(&game).await;
        if let Some(name) = shim::deploy(&exe, &account).await? {
            println!("[ubi-direct] deployed {name} for {}", game.name);
        }
        if exe.parent() != Some(install_dir.as_path()) {
            if let Ok(Some(loader)) = shim::detect(&exe) {
                shim::write_account_config(&install_dir, &account, loader.family)?;
            }
        }
    } else if let Ok(Some(loader)) = shim::detect(&exe) {
        return Err(format!(
            "{} imports {}; enable the Uplay compatibility shim in Settings -> Integrations to launch it without Ubisoft Connect",
            game.name, loader.name
        ));
    }

    let mut command = Command::new(&exe);
    command.current_dir(&install_dir);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("starting {}: {e}", exe.display()))
}

async fn shim_account(game: &ubi_installs::InstalledGame) -> shim::ShimAccount {
    let mut account_id = String::new();
    let mut name = String::new();
    let mut ticket = game.ticket.clone();
    if let Ok((mut demux, session)) = super::connect().await {
        account_id = session.user_id.clone();
        name = session.name.clone();
        if game.uplay_id != 0 {
            if let Ok(Some(fresh)) = demux.uplay_ticket(game.uplay_id).await {
                ticket = fresh;
            }
        }
    }
    if account_id.is_empty() {
        account_id = format!("efxlve-{}", game.product_id);
    }
    if name.is_empty() {
        name = "Player".to_string();
    }
    if ticket.is_empty() {
        // The shim only needs a non-null value here; ownership was already
        // checked against Demux before the launch path was reached.
        ticket = "efxlve".to_string();
    }
    let handle: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let handle = if handle.is_empty() {
        "player".to_string()
    } else {
        handle.to_lowercase()
    };
    shim::ShimAccount {
        product_id: game.product_id,
        account_id,
        name,
        email: format!("{handle}@efxlve.local"),
        ticket,
    }
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

/// The game's own install-path value (for example Beyond Good & Evil's
/// `HKLM\SOFTWARE\Ubisoft\Beyond Good & Evil\Install path`). Without it the
/// game or its settings app can report "not properly installed".
fn seed_game_registry(game: &ubi_installs::InstalledGame, install_dir: &Path) {
    let Some((key, value_name)) = split_register(&game.install_reg) else {
        return;
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let data = install_dir.display().to_string();
        let mut keys = vec![key.clone()];
        if let Some(wow64) = wow64_key(&key) {
            keys.push(wow64);
        }
        for key in keys {
            let mut command = Command::new("reg");
            command.args([
                "add",
                &key,
                "/v",
                &value_name,
                "/t",
                "REG_SZ",
                "/d",
                &data,
                "/f",
            ]);
            command.creation_flags(CREATE_NO_WINDOW);
            let _ = command.status();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (key, value_name, install_dir);
    }
}

fn split_register(register: &str) -> Option<(String, String)> {
    let register = register
        .trim()
        .replace("HKEY_LOCAL_MACHINE", "HKLM")
        .replace("HKEY_CURRENT_USER", "HKCU");
    let index = register.rfind('\\')?;
    let key = register[..index].trim();
    let value = register[index + 1..].trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key.to_string(), value.to_string()))
}

fn wow64_key(key: &str) -> Option<String> {
    let upper = key.to_uppercase();
    if upper.contains("WOW6432NODE") {
        return None;
    }
    let prefix = "HKLM\\SOFTWARE\\";
    if upper.starts_with(prefix) {
        Some(format!("HKLM\\SOFTWARE\\Wow6432Node\\{}", &key[prefix.len()..]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_exe, split_register, wow64_key};

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

    #[test]
    fn splits_the_games_registry_value_and_adds_the_wow64_view() {
        assert_eq!(
            split_register(r"HKEY_LOCAL_MACHINE\SOFTWARE\Ubisoft\Game\Install path"),
            Some((
                r"HKLM\SOFTWARE\Ubisoft\Game".to_string(),
                "Install path".to_string()
            ))
        );
        assert_eq!(
            wow64_key(r"HKLM\SOFTWARE\Ubisoft\Game"),
            Some(r"HKLM\SOFTWARE\Wow6432Node\Ubisoft\Game".to_string())
        );
        assert_eq!(wow64_key(r"HKCU\Software\Ubisoft"), None);
    }
}
