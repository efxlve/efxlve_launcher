//! Safe removal of the Epic Games Launcher.
//!
//! Epic's own uninstaller deletes the game folders together with the launcher
//! (their support article says the reinstall process removes all installed
//! games), so this removes only launcher-owned files, shortcuts and registry
//! entries. Games, their `.egstore` manifests and Epic Online Services stay
//! untouched, and every installed game is migrated into Legendary first.

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;

/// One game the removal keeps (installed through the Epic Games Launcher).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptGame {
    pub app_name: String,
    pub title: String,
    pub install_path: String,
    /// Install folder and its `.egstore` manifest are present.
    pub healthy: bool,
}

/// What the safe removal will do, shown in the confirmation dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EglRemovalPlan {
    pub games: Vec<KeptGame>,
    /// Launcher-owned folders that exist and will be removed.
    pub remove_paths: Vec<String>,
    /// Shortcuts that exist and will be removed.
    pub remove_shortcuts: Vec<String>,
    /// Uninstall registry keys that will be removed.
    pub remove_registry: Vec<String>,
    /// Epic Online Services folder found on disk (kept).
    pub eos_path: String,
}

/// What the removal did; counts are re-checked after the elevated script.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EglRemovalResult {
    pub removed_paths: u32,
    pub removed_shortcuts: u32,
    pub removed_registry: u32,
    pub games_kept: u32,
    pub games_healthy: u32,
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// Folders that belong to the launcher itself, never to a game. The launcher
/// data folder is included: its manifests are migrated into Legendary first.
/// `UnrealEngineLauncher` and Epic Online Services are deliberately not here.
fn launcher_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = env_path("LOCALAPPDATA") {
        out.push(local.join("Epic Games").join("Launcher"));
        out.push(local.join("EpicGamesLauncher"));
    }
    out.push(PathBuf::from(r"C:\Program Files\Epic Games\Launcher"));
    out.push(PathBuf::from(r"C:\Program Files (x86)\Epic Games\Launcher"));
    out.push(PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher"));
    out
}

/// Launcher shortcuts: Start Menu and both desktops.
fn launcher_shortcuts() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(appdata) = env_path("APPDATA") {
        out.push(
            appdata
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Epic Games Launcher.lnk"),
        );
    }
    if let Some(profile) = env_path("USERPROFILE") {
        out.push(profile.join("Desktop").join("Epic Games Launcher.lnk"));
    }
    if let Some(public) = env_path("PUBLIC") {
        out.push(public.join("Desktop").join("Epic Games Launcher.lnk"));
    }
    out
}

/// Epic Online Services, kept for games that use its multiplayer and overlay.
fn eos_path() -> PathBuf {
    PathBuf::from(r"C:\Program Files (x86)\Epic Games\Epic Online Services")
}

fn to_strings(paths: Vec<PathBuf>, only_existing: bool) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| !only_existing || p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// Runs a PowerShell one-liner and returns its stdout.
async fn powershell(script: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Uninstall registry keys whose display name is exactly the launcher's.
async fn uninstall_keys() -> Vec<String> {
    let script = "$roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', \
                  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', \
                  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); \
                  $out = @(Get-ChildItem $roots -ErrorAction SilentlyContinue | ForEach-Object { \
                  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; \
                  if ($p.DisplayName -eq 'Epic Games Launcher') { $_.Name } }); \
                  ConvertTo-Json -Compress @($out)";
    let Ok(text) = powershell(script).await else {
        return Vec::new();
    };
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or_default();
    match value {
        serde_json::Value::Array(rows) => rows
            .into_iter()
            .filter_map(|row| row.as_str().map(str::to_string))
            .collect(),
        serde_json::Value::String(row) => vec![row],
        _ => Vec::new(),
    }
}

/// Detected EGL games with their folder health.
fn kept_games() -> Vec<KeptGame> {
    crate::legendary::cache::read_egl_installed_games()
        .into_iter()
        .map(|game| {
            let healthy = std::path::Path::new(&game.install_path).join(".egstore").is_dir();
            KeptGame {
                app_name: game.app_name,
                title: game.title,
                install_path: game.install_path,
                healthy,
            }
        })
        .collect()
}

/// What the safe removal would do. Read-only; drives the confirmation dialog.
#[tauri::command]
pub async fn egl_removal_plan() -> Result<EglRemovalPlan, String> {
    let games = tauri::async_runtime::spawn_blocking(kept_games)
        .await
        .map_err(|e| e.to_string())?;
    let remove_registry = uninstall_keys().await;
    let eos = eos_path();
    Ok(EglRemovalPlan {
        games,
        remove_paths: to_strings(launcher_paths(), true),
        remove_shortcuts: to_strings(launcher_shortcuts(), true),
        remove_registry,
        eos_path: if eos.is_dir() { eos.to_string_lossy().to_string() } else { String::new() },
    })
}

/// One command line of the elevated removal script.
fn script_line(body: &mut String, command: &str) {
    body.push_str(command);
    body.push_str(" >> \"%LOG%\" 2>&1\r\n");
}

/// Removes the launcher: migrates the games first, then deletes only
/// launcher-owned paths, shortcuts and registry entries through one elevated
/// script. Game folders are never touched.
#[tauri::command]
pub async fn egl_remove() -> Result<EglRemovalResult, String> {
    // 1. Migration: every game must be known to Legendary before anything goes.
    let egl = tauri::async_runtime::spawn_blocking(crate::legendary::cache::read_egl_installed_games)
        .await
        .map_err(|e| e.to_string())?;
    let config = crate::legendary::skip::default_config_dir();
    for game in &egl {
        crate::legendary::cache::ensure_egl_manifest(
            &config,
            &game.app_name,
            &game.install_path,
            &game.version,
            "Windows",
        );
    }
    let _ = crate::legendary::commands::sync_egl_installed();
    let games: Vec<KeptGame> = egl
        .into_iter()
        .map(|game| KeptGame {
            healthy: std::path::Path::new(&game.install_path).join(".egstore").is_dir(),
            app_name: game.app_name,
            title: game.title,
            install_path: game.install_path,
        })
        .collect();

    // 2. Removal: launcher-owned items only, with one UAC prompt.
    let log = std::env::temp_dir().join("efxlve-egl-remove.log");
    let script = std::env::temp_dir().join("efxlve-egl-remove.cmd");
    let mut body = String::from("@echo off\r\n");
    body.push_str(&format!("set \"LOG={}\"\r\n", log.display()));
    body.push_str("> \"%LOG%\" echo start\r\n");
    for exe in [
        "EpicGamesLauncher.exe",
        "EpicGamesLauncherSetup.exe",
        "EpicGamesLauncherUpdate.exe",
        "EpicGamesLauncherMigrate.exe",
        "EpicWebHelper.exe",
    ] {
        script_line(&mut body, &format!("taskkill /IM {exe} /F"));
    }
    let paths = launcher_paths();
    for path in &paths {
        script_line(&mut body, &format!("rmdir /S /Q \"{}\"", path.display()));
    }
    let shortcuts = launcher_shortcuts();
    for path in &shortcuts {
        script_line(&mut body, &format!("del /F /Q \"{}\"", path.display()));
    }
    // Autostart values the launcher wrote under the user's Run key.
    for value in ["EpicGamesLauncher", "Epic Games Launcher"] {
        script_line(
            &mut body,
            &format!("reg delete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\" /v \"{value}\" /f"),
        );
    }
    let keys = uninstall_keys().await;
    for key in &keys {
        script_line(&mut body, &format!("reg delete \"{key}\" /f"));
    }
    body.push_str(">> \"%LOG%\" echo done\r\n");
    std::fs::write(&script, body).map_err(|e| e.to_string())?;

    let ps = format!(
        "$p = Start-Process -FilePath '{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        script.display()
    );
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() { "elevation declined".into() } else { detail });
    }

    // 3. Verification: count what actually disappeared, and that the games
    //    are still on disk.
    let removed_paths = paths.iter().filter(|p| !p.exists()).count() as u32;
    let removed_shortcuts = shortcuts.iter().filter(|p| !p.exists()).count() as u32;
    let removed_registry = keys.len() as u32 - uninstall_keys().await.len() as u32;
    let games_kept = games.len() as u32;
    let games_healthy = games
        .iter()
        .filter(|game| std::path::Path::new(&game.install_path).join(".egstore").is_dir())
        .count() as u32;
    Ok(EglRemovalResult {
        removed_paths,
        removed_shortcuts,
        removed_registry,
        games_kept,
        games_healthy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_paths_never_point_inside_a_game_folder() {
        // The whole point of the safe removal: only launcher-owned folders may
        // ever be deleted, never `Epic Games\<Game>`.
        for path in launcher_paths() {
            let text = path.to_string_lossy().to_lowercase();
            assert!(
                text.ends_with("launcher") || text.ends_with("epicgameslauncher"),
                "unexpected removal path: {text}"
            );
        }
    }
}
