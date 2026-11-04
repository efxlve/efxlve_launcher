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
    if game.client_launch {
        return launch_via_client(&game);
    }
    let install_dir = PathBuf::from(&game.install_dir);
    if !install_dir.is_dir() {
        return Err(format!("install folder is missing: {}", install_dir.display()));
    }
    // Anti-cheat and Connect-only DRM titles must never see the shim. The
    // install folder scan covers titles whose store name is unfamiliar.
    if crate::overlay::anti_cheat::game_has_anti_cheat(&game.name, Some(&game.install_dir)) {
        return Err(format!(
            "{} uses an anti-cheat service; keep it on Ubisoft Connect. The direct launcher will not bypass it.",
            game.name
        ));
    }
    let exe = resolve_exe(&install_dir, &game.exe)?;
    seed_registry(product_id, &install_dir);
    seed_game_registry(&game, &install_dir);

    let detected_loader = match shim::detect(&exe)? {
        Some(loader) => Some(loader),
        None if exe.parent() != Some(install_dir.as_path()) => {
            shim::detect_in_dir(&install_dir, true)?
        }
        None => None,
    };

    if shim_enabled {
        let account = shim_account(&game).await;
        if let Some(loader) = &detected_loader {
            if let Some(exe_dir) = exe.parent() {
                shim::deploy_loader_to_dir(exe_dir, loader, &account).await?;
            }
            println!("[ubi-direct] deployed {} for {}", loader.name, game.name);
            // The shim keeps saves beside its config. Carry the Connect slots
            // over before the first direct start, without overwriting a direct
            // save that is already newer.
            match super::saves::migrate_connect_saves(
                product_id,
                game.uplay_id,
                &install_dir,
                exe.parent(),
            ) {
                Ok(0) => {}
                Ok(count) => println!(
                    "[ubi-direct] imported {count} Connect save slot(s) for {}",
                    game.name
                ),
                Err(error) => println!("[ubi-direct] save import skipped: {error}"),
            }
            if exe.parent() != Some(install_dir.as_path()) {
                if install_dir.join(&loader.name).is_file() {
                    shim::deploy_loader_to_dir(&install_dir, loader, &account).await?;
                } else {
                    shim::write_account_config(&install_dir, &account, loader.family)?;
                }
            }
        }
    } else if let Some(loader) = detected_loader {
        return Err(format!(
            "{} imports {}; enable the Uplay compatibility shim in Settings -> Integrations to launch it without Ubisoft Connect",
            game.name, loader.name
        ));
    }

    let mut command = Command::new(&exe);
    command.current_dir(working_dir(&install_dir, &exe, &game.working_dir));
    let args = crate::companion::ubisoft::split_launch_arguments(&game.launch_args);
    if !args.is_empty() {
        command.args(&args);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("starting {}: {e}", exe.display()))
}

/// Prefer the working directory from `start_game` in the product configuration.
/// Otherwise Ubisoft's Unreal titles keep the exe under `Binaries\Win32`/`Win64`
/// or `System\` and resolve their data from there, while everything else runs
/// from the install root.
fn working_dir(install_dir: &Path, exe: &Path, configured: &str) -> PathBuf {
    let configured = configured.trim();
    if !configured.is_empty() {
        if let Ok(custom) = super::manifest::safe_install_path(install_dir, configured) {
            if custom.is_dir() || !install_dir.exists() {
                return custom;
            }
        }
    }
    if let Some(parent) = exe.parent() {
        let name = parent
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name == "system" || name == "win32" || name == "win64" {
            return parent.to_path_buf();
        }
    }
    install_dir.to_path_buf()
}

fn client_launch_uri(game: &ubi_installs::InstalledGame) -> String {
    let launch_id = if game.uplay_id != 0 {
        game.uplay_id
    } else {
        game.product_id
    };
    format!("uplay://launch/{launch_id}/0")
}

fn launch_via_client(game: &ubi_installs::InstalledGame) -> Result<(), String> {
    if !crate::companion::client_installed("ubisoft") {
        return Err(
            "Ubisoft Connect is not installed; install it or switch this game back to direct launch"
                .to_string(),
        );
    }
    crate::companion::launch::open_game(&client_launch_uri(game), "")
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
    let response = crate::companion::ubi_achievements::achievements_for(
        &game.product_id.to_string(),
        &game.name,
        "en",
    );
    let achievements = response
        .achievements
        .into_iter()
        .filter_map(|item| {
            let id = item.name.parse::<u32>().ok()?;
            Some(shim::ShimAchievement {
                id,
                name: item.display_name,
                description: item.description,
                achieved: item.unlocked,
            })
        })
        .collect();
    let chunk_ids = if !game.chunk_ids.is_empty() {
        game.chunk_ids.clone()
    } else {
        super::manifest::read_local_install(Path::new(&game.install_dir))
            .map(|(manifest, _)| manifest.chunk_ids)
            .unwrap_or_default()
    };
    shim::ShimAccount {
        product_id: game.product_id,
        account_id,
        name,
        email: format!("{handle}@efxlve.local"),
        ticket,
        chunk_ids,
        achievements,
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

/// Ubisoft titles resolve their install folder from these keys. Per-machine
/// keys need elevation, so per-user and UAC VirtualStore mirrors are written
/// alongside them for non-elevated launches.
pub(crate) fn seed_registry(product_id: u32, install_dir: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let value = install_dir.display().to_string();
        let keys = [
            format!(r"HKCU\Software\Ubisoft\Launcher\Installs\{product_id}"),
            format!(r"HKCU\Software\Wow6432Node\Ubisoft\Launcher\Installs\{product_id}"),
            format!(
                r"HKCU\Software\Classes\VirtualStore\MACHINE\SOFTWARE\Wow6432Node\Ubisoft\Launcher\Installs\{product_id}"
            ),
            format!(r"HKLM\SOFTWARE\Ubisoft\Launcher\Installs\{product_id}"),
            format!(r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\{product_id}"),
        ];
        for key in keys {
            for (name, data) in [("InstallDir", value.as_str()), ("Language", "en-US")] {
                let mut command = Command::new("reg");
                command.args([
                    "add",
                    &key,
                    "/v",
                    name,
                    "/t",
                    "REG_SZ",
                    "/d",
                    data,
                    "/f",
                ]);
                command.creation_flags(CREATE_NO_WINDOW);
                let _ = command.status();
            }
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
pub(crate) fn seed_game_registry(game: &ubi_installs::InstalledGame, install_dir: &Path) {
    let Some((key, value_name)) = split_register(&game.install_reg) else {
        return;
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let data = install_dir.display().to_string();
        for key in registry_key_variants(&key) {
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

fn registry_key_variants(key: &str) -> Vec<String> {
    let mut keys = vec![key.to_string()];
    if let Some(wow64) = wow64_key(key) {
        keys.push(wow64);
    }
    let upper = key.to_uppercase();
    let hklm_prefix = "HKLM\\SOFTWARE\\";
    if upper.starts_with(hklm_prefix) {
        let tail = &key[hklm_prefix.len()..];
        let tail_no_wow = if tail.to_uppercase().starts_with("WOW6432NODE\\") {
            &tail["WOW6432NODE\\".len()..]
        } else {
            tail
        };
        for extra in [
            format!("HKCU\\Software\\{tail_no_wow}"),
            format!("HKCU\\Software\\Wow6432Node\\{tail_no_wow}"),
            format!(
                "HKCU\\Software\\Classes\\VirtualStore\\MACHINE\\SOFTWARE\\Wow6432Node\\{tail_no_wow}"
            ),
        ] {
            if !keys.iter().any(|existing| existing.eq_ignore_ascii_case(&extra)) {
                keys.push(extra);
            }
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::{
        client_launch_uri, registry_key_variants, resolve_exe, split_register, wow64_key,
        working_dir,
    };
    use crate::companion::ubi_installs::InstalledGame;

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
        let variants = registry_key_variants(r"HKLM\SOFTWARE\Ubisoft\Game");
        assert!(variants.contains(&r"HKCU\Software\Ubisoft\Game".to_string()));
        assert!(variants.contains(
            &r"HKCU\Software\Classes\VirtualStore\MACHINE\SOFTWARE\Wow6432Node\Ubisoft\Game"
                .to_string()
        ));
    }

    #[test]
    fn unreal_binaries_run_from_their_own_folder() {
        let root = std::path::Path::new("Game");
        let win32 = root.join("Binaries").join("Win32").join("ACCGame.exe");
        assert_eq!(
            working_dir(root, &win32, ""),
            root.join("Binaries").join("Win32")
        );
        assert_eq!(
            working_dir(root, &root.join("Rayman Origins.exe"), ""),
            root.to_path_buf()
        );
        assert_eq!(
            working_dir(root, &root.join("Rayman Origins.exe"), "bin\\x64"),
            root.join("bin").join("x64")
        );
    }

    #[test]
    fn client_launch_uri_prefers_the_uplay_id_then_the_product_id() {
        let mut game = InstalledGame {
            product_id: 80,
            name: "Game".into(),
            install_dir: "C:\\Game".into(),
            exe: "game.exe".into(),
            uplay_id: 1651,
            client_launch: true,
            ..Default::default()
        };
        assert_eq!(client_launch_uri(&game), "uplay://launch/1651/0");
        game.uplay_id = 0;
        assert_eq!(client_launch_uri(&game), "uplay://launch/80/0");
    }
}
