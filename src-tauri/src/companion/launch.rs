//! Hand play back to the DRM client.
//!
//! Ubisoft and Battle.net use their protocol handlers. An Xbox game starts
//! from the executable named in its own `MicrosoftGame.config` when that file
//! is inside the game folder. Otherwise the Xbox app opens.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::scan::client_exe;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn client_installed(store: &str) -> bool {
    match store {
        "ea" => ea_exe().is_some(),
        "ubisoft" => ubi_exe().is_some(),
        "battlenet" => bnet_exe().is_some(),
        "xbox" => xbox_present(),
        "riot" => super::riot::client_exe().is_some(),
        _ => false,
    }
}

pub(crate) fn open_client(store: &str) -> Result<(), String> {
    if store == "xbox" {
        return open_xbox_app();
    }
    let path = match store {
        "ea" => ea_exe(),
        "ubisoft" => ubi_exe(),
        "battlenet" => bnet_exe(),
        "riot" => super::riot::client_exe(),
        _ => None,
    };
    let Some(path) = path else {
        return Err("@t:accounts.clientMissing".into());
    };
    Command::new(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub(crate) fn open_game(uri: &str, exe: &str) -> Result<(), String> {
    if !exe.is_empty() {
        return open_exe(exe);
    }
    if uri.is_empty() {
        return Err("@t:accounts.clientMissing".into());
    }
    // Store games start through their package identity, not a path.
    if let Some(aumid) = uri.strip_prefix("aumid:") {
        return open_aumid(aumid);
    }
    if !safe_uri(uri) {
        return Err("Unsupported game URL".into());
    }
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| e.to_string())
}

/// Starts an installed Store package through the shell app folder.
fn open_aumid(aumid: &str) -> Result<(), String> {
    if !super::xbox_login::safe_aumid(aumid) {
        return Err("@t:accounts.clientMissing".into());
    }
    let mut cmd = Command::new("explorer.exe");
    cmd.arg(format!(r"shell:AppsFolder\{aumid}"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Runs one of the client's own tools (e.g. the Blizzard uninstaller) without a
/// shell, so arguments cannot be re-interpreted.
pub(crate) fn run_command(exe: &Path, args: &[String]) -> Result<(), String> {
    if !exe.is_file() {
        return Err("@t:accounts.clientMissing".into());
    }
    let mut cmd = Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn open_exe(exe: &str) -> Result<(), String> {
    let path = PathBuf::from(exe);
    if !path.is_file() || !exe_is_inside_game(&path) {
        return Err("@t:accounts.clientMissing".into());
    }
    let mut cmd = Command::new(&path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn exe_is_inside_game(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !name.to_ascii_lowercase().ends_with(".exe") {
        return false;
    }
    path.ancestors().any(|dir| dir.join("MicrosoftGame.config").is_file() || dir.join("Content").join("MicrosoftGame.config").is_file())
}

fn safe_uri(uri: &str) -> bool {
    // EA deep links carry a comma-separated content-id list and one optional
    // flag, so they are checked before the generic character rule (`&`).
    if let Some(rest) = uri.strip_prefix("origin2://game/launch") {
        return safe_ea_launch(rest);
    }
    if uri.bytes().any(|b| b == b'"' || b == b'\n' || b == b'\r' || b == b'&' || b == b'|' || b == b' ') {
        return false;
    }
    if let Some(rest) = uri.strip_prefix("uplay://launch/") {
        let mut parts = rest.split('/');
        let id = parts.next().unwrap_or("");
        return !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) && parts.next() == Some("0") && parts.next().is_none();
    }
    if let Some(id) = uri.strip_prefix("uplay://install/") {
        return !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
    }
    if let Some(id) = uri.strip_prefix("uplay://uninstall/") {
        return !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
    }
    if let Some(code) = uri.strip_prefix("battlenet://") {
        return !code.is_empty()
            && code.len() <= 32
            && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !matches!(code, "agent" | "bna");
    }
    if let Some(pfn) = uri.strip_prefix("ms-windows-store://pdp/?PFN=") {
        return !pfn.is_empty()
            && pfn.len() <= 128
            && pfn
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }
    false
}

/// `origin2://game/launch?offerIds=<id[,id...]>[&autoDownload=1]`.
fn safe_ea_launch(rest: &str) -> bool {
    let Some(query) = rest.strip_prefix('?') else {
        return false;
    };
    let mut parts = query.split('&');
    let Some(ids) = parts.next().and_then(|first| first.strip_prefix("offerIds=")) else {
        return false;
    };
    if ids.is_empty() || ids.len() > 256 {
        return false;
    }
    let ids_ok = ids.split(',').all(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == ':' || c == '-')
    });
    ids_ok && parts.all(|part| part == "autoDownload=1")
}

fn ea_exe() -> Option<PathBuf> {
    client_exe(&[
        r"C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EALauncher.exe",
        r"C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EADesktop.exe",
    ])
}

fn ubi_exe() -> Option<PathBuf> {
    client_exe(&[
        r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\UbisoftConnect.exe",
        r"C:\Program Files\Ubisoft\Ubisoft Game Launcher\UbisoftConnect.exe",
    ])
}

fn bnet_exe() -> Option<PathBuf> {
    client_exe(&[
        r"C:\Program Files (x86)\Battle.net\Battle.net.exe",
        r"C:\Program Files\Battle.net\Battle.net.exe",
    ])
}

fn xbox_present() -> bool {
    if Path::new(r"C:\XboxGames").is_dir() {
        return true;
    }
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    PathBuf::from(base)
        .join("Packages")
        .join("Microsoft.GamingApp_8wekyb3d8bbwe")
        .is_dir()
}

fn open_xbox_app() -> Result<(), String> {
    let mut cmd = Command::new("explorer.exe");
    cmd.arg(r"shell:AppsFolder\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_store_protocols_pass() {
        assert!(safe_uri("uplay://launch/34/0"));
        assert!(safe_uri("uplay://install/34"));
        assert!(safe_uri("uplay://uninstall/34"));
        assert!(!safe_uri("uplay://launch/34/0 & calc"));
        assert!(!safe_uri("uplay://install/34/0"));
        assert!(!safe_uri("uplay://uninstall/abc"));
        assert!(safe_uri("battlenet://fenris"));
        assert!(!safe_uri("https://example.com"));
        assert!(!safe_uri("battlenet://agent"));
    }

    #[test]
    fn only_well_formed_ea_deep_links_pass() {
        assert!(safe_uri("origin2://game/launch?offerIds=71592"));
        assert!(safe_uri("origin2://game/launch?offerIds=1002975,1003943&autoDownload=1"));
        assert!(safe_uri("origin2://game/launch?offerIds=OFB-EAST:48217"));
        assert!(!safe_uri("origin2://game/launch?offerIds=71592&x=1"));
        assert!(!safe_uri("origin2://game/launch?offerIds=71592%20"));
        assert!(!safe_uri("origin2://game/launch?offerIds="));
        assert!(!safe_uri("origin2://game/launch"));
        assert!(!safe_uri("origin2://game/uninstall?offerIds=71592"));
    }

    #[test]
    fn microsoft_store_product_links_pass() {
        assert!(safe_uri("ms-windows-store://pdp/?PFN=Microsoft.ForzaHorizon5_8wekyb3d8bbwe"));
        assert!(!safe_uri("ms-windows-store://pdp/?PFN=Bad App"));
        assert!(!safe_uri("ms-windows-store://pdp/?PFN="));
        assert!(!safe_uri("ms-windows-store://pdp/?PFN=x&calc"));
    }
}
