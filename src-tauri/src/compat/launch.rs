//! Launch plumbing for Wine/Proton on Linux and macOS.
//!
//! Windows starts the game executable directly. Everywhere else the game is a
//! PE binary and needs a runner; the compatibility manager installs the runner,
//! and this module turns the selected runner plus a per-game prefix into the
//! wrapper and environment Legendary, gogdl and Nile pass to the game process.
//!
//! Nothing here runs on Windows: `launch_spec` returns an empty spec, so the
//! Windows path keeps using its own wrapper/relay logic unchanged.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use super::catalog::Target;
use super::install::compat_root;

/// Settings shown in Settings > Compatibility.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatLaunchConfig {
    pub runner: Option<String>,
    pub runner_tag: Option<String>,
    /// A runner outside the launcher's folder; empty means the managed copy.
    pub runner_path: Option<String>,
    pub prefix_dir: String,
    pub umu_enabled: bool,
}

/// What the store launcher prepends to the game command.
#[derive(Clone, Debug, Default)]
pub struct CompatLaunchSpec {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl CompatLaunchSpec {
    /// The single string `legendary --wrapper` and `nile --wrapper` expect.
    /// Paths are quoted because Legendary passes the value through `shlex`.
    pub fn wrapper_command(&self) -> Option<String> {
        let program = self.program.as_ref()?;
        let mut out = format!("\"{program}\"");
        for arg in &self.args {
            out.push(' ');
            out.push_str(arg);
        }
        Some(out)
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn default_prefix_dir() -> PathBuf {
    home_dir().join("Games").join("Efxlve").join("Prefixes")
}

fn sanitize_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(80));
    for ch in value.chars() {
        if out.len() >= 80 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() || out.chars().all(|ch| ch == '.') {
        "game".to_string()
    } else {
        out
    }
}

fn steam_install_path() -> PathBuf {
    let home = home_dir();
    for candidate in [
        home.join(".steam/steam"),
        home.join(".steam/root"),
        home.join(".local/share/Steam"),
        home.join("Library/Application Support/Steam"),
    ] {
        if candidate.is_dir() {
            return candidate;
        }
    }
    home
}

fn installed_tag(app: &AppHandle, target: &Target, id: &str) -> Option<String> {
    let root = compat_root(app).join(target.key()).join(id);
    let mut entries: Vec<(u64, String)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let tag = entry.file_name().to_string_lossy().to_string();
            if tag.starts_with('.') {
                return None;
            }
            let stamp = std::fs::metadata(entry.path())
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_secs())
                .unwrap_or(0);
            Some((stamp, tag))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().next().map(|(_, tag)| tag)
}

fn runner_dir(app: &AppHandle, target: &Target, id: &str, tag: Option<&str>) -> Option<PathBuf> {
    let tag = tag
        .map(str::to_string)
        .or_else(|| installed_tag(app, target, id))?;
    let dir = compat_root(app).join(target.key()).join(id).join(tag);
    dir.is_dir().then_some(dir)
}

/// The executable and leading arguments for one runner folder. Kept separate
/// from `launch_spec` so the choice can be tested without a Tauri handle.
fn runner_program(id: &str, dir: &std::path::Path) -> Option<(PathBuf, Vec<String>)> {
    match id {
        "ge-proton" | "proton-cachyos" => {
            let proton = dir.join("proton");
            proton.is_file().then(|| (proton, vec!["run".to_string()]))
        }
        "wine-staging" => {
            let wine = if dir.join("bin/wine64").is_file() {
                dir.join("bin/wine64")
            } else {
                dir.join("bin/wine")
            };
            wine.is_file().then_some((wine, Vec::new()))
        }
        _ => None,
    }
}

fn configured_runner_path(settings: &crate::EpicSettings) -> Option<PathBuf> {
    settings
        .compat_runner_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn runner_for(app: &AppHandle) -> Option<String> {
    let settings = crate::load_settings(app);
    if let Some(runner) = settings
        .compat_runner
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(runner.to_string());
    }
    // First run on a non-Windows build: use the runner the user already
    // installed instead of making the first launch fail with "no runner".
    let target = Target::current();
    for candidate in ["ge-proton", "proton-cachyos", "wine-staging"] {
        if runner_dir(app, &target, candidate, None).is_some() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn store_of(app_name: &str) -> &'static str {
    if app_name.starts_with("gog::") {
        "gog"
    } else if app_name.starts_with("amazon::") {
        "amazon"
    } else if app_name.starts_with("steam::") {
        "steam"
    } else {
        "epic"
    }
}

/// Builds the wrapper for one game. On Windows, and when no runner is
/// installed, this returns an empty spec and the caller keeps its old path.
pub fn launch_spec(app: &AppHandle, app_name: &str) -> CompatLaunchSpec {
    let mut spec = CompatLaunchSpec::default();
    if cfg!(windows) {
        return spec;
    }
    let settings = crate::load_settings(app);
    let target = Target::current();
    let prefix_root = settings
        .compat_prefix_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_prefix_dir);
    let prefix = prefix_root.join(sanitize_segment(app_name));
    let _ = std::fs::create_dir_all(&prefix);

    let runner = runner_for(app);
    let umu_enabled = settings.compat_umu_enabled.unwrap_or(true);
    let umu_dir = runner_dir(app, &target, "umu-launcher", None);
    // A runner chosen from the system tree (Steam's compatibilitytools.d, a
    // Lutris build) wins over the launcher's own copy.
    let runner_dir = configured_runner_path(&settings).or_else(|| {
        runner.as_deref().and_then(|id| {
            let tag = if settings
                .compat_runner
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some()
            {
                settings.compat_runner_tag.as_deref()
            } else {
                None
            };
            runner_dir(app, &target, id, tag)
        })
    });

    // The environment is shared by both paths: umu and Proton both read it.
    spec.env
        .insert("WINEPREFIX".to_string(), prefix.display().to_string());
    spec.env.insert(
        "GAMEID".to_string(),
        format!("efxlve-{}", sanitize_segment(app_name)),
    );
    spec.env
        .insert("STORE".to_string(), store_of(app_name).to_string());
    if let Some(dir) = runner_dir.as_ref() {
        spec.env
            .insert("PROTONPATH".to_string(), dir.display().to_string());
        spec.env.insert(
            "STEAM_COMPAT_DATA_PATH".to_string(),
            prefix.display().to_string(),
        );
        spec.env.insert(
            "STEAM_COMPAT_CLIENT_INSTALL_PATH".to_string(),
            steam_install_path().display().to_string(),
        );
        spec.env
            .insert("STEAM_COMPAT_APP_ID".to_string(), "0".to_string());
    }

    // umu-launcher is the modern wrapper: it sets up the Steam runtime and
    // calls the Proton build, so it wins when the user has it installed.
    if umu_enabled {
        if let Some(dir) = umu_dir.as_ref() {
            let umu = dir.join("umu-run");
            if umu.is_file() {
                spec.program = Some(umu.display().to_string());
                return spec;
            }
        }
    }

    let Some(runner) = runner else {
        return spec;
    };
    let Some(dir) = runner_dir else {
        return spec;
    };
    if let Some((program, args)) = runner_program(&runner, &dir) {
        spec.program = Some(program.display().to_string());
        spec.args = args;
    }
    spec
}

fn valid_runner(id: &str) -> bool {
    matches!(id, "ge-proton" | "proton-cachyos" | "wine-staging")
}

#[tauri::command]
pub fn compat_get_launch_config(app: AppHandle) -> CompatLaunchConfig {
    let settings = crate::load_settings(&app);
    CompatLaunchConfig {
        runner: settings
            .compat_runner
            .clone()
            .filter(|value| !value.trim().is_empty()),
        runner_tag: settings
            .compat_runner_tag
            .clone()
            .filter(|value| !value.trim().is_empty()),
        runner_path: settings
            .compat_runner_path
            .clone()
            .filter(|value| !value.trim().is_empty()),
        prefix_dir: settings
            .compat_prefix_dir
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_prefix_dir().display().to_string()),
        umu_enabled: settings.compat_umu_enabled.unwrap_or(true),
    }
}

#[tauri::command]
pub fn compat_set_launch_config(
    app: AppHandle,
    runner: Option<String>,
    runner_tag: Option<String>,
    runner_path: Option<String>,
    prefix_dir: Option<String>,
    umu_enabled: Option<bool>,
) -> Result<(), String> {
    let runner = runner
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(id) = runner.as_deref() {
        if !valid_runner(id) {
            return Err("@t:compat.unknownRunner".to_string());
        }
    }
    let runner_path = runner_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(path) = runner_path.as_deref() {
        if runner.is_none() || !std::path::Path::new(path).is_dir() {
            return Err("@t:compat.badRunnerPath".to_string());
        }
    }
    let mut settings = crate::load_settings(&app);
    settings.compat_runner = runner;
    settings.compat_runner_tag = runner_tag
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    settings.compat_runner_path = runner_path;
    settings.compat_prefix_dir = prefix_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(enabled) = umu_enabled {
        settings.compat_umu_enabled = Some(enabled);
    }
    crate::save_settings(&app, &settings);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_game_name_cannot_escape_the_prefix_root() {
        assert_eq!(sanitize_segment("../../evil"), ".._.._evil");
        assert_eq!(sanitize_segment("Tom & Jerry"), "Tom___Jerry");
        assert_eq!(sanitize_segment(""), "game");
        assert_eq!(sanitize_segment(".."), "game");
        assert_eq!(sanitize_segment("."), "game");
    }

    #[test]
    fn a_system_runner_folder_resolves_to_its_program() {
        let root = std::env::temp_dir().join(format!("efxlve_runner_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proton_dir = root.join("GE-Proton11-10");
        std::fs::create_dir_all(&proton_dir).unwrap();
        std::fs::write(proton_dir.join("proton"), b"#!/bin/sh").unwrap();
        let (program, args) = runner_program("ge-proton", &proton_dir).expect("proton");
        assert_eq!(program, proton_dir.join("proton"));
        assert_eq!(args, vec!["run".to_string()]);

        let wine_dir = root.join("Wine-Staging");
        std::fs::create_dir_all(wine_dir.join("bin")).unwrap();
        std::fs::write(wine_dir.join("bin/wine64"), b"#!/bin/sh").unwrap();
        let (program, args) = runner_program("wine-staging", &wine_dir).expect("wine");
        assert_eq!(program, wine_dir.join("bin/wine64"));
        assert!(args.is_empty());

        assert!(runner_program("ge-proton", &root.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wrapper_quotes_the_program_and_keeps_its_arguments() {
        let spec = CompatLaunchSpec {
            program: Some("/home/me/GE-Proton/proton".to_string()),
            args: vec!["run".to_string()],
            env: BTreeMap::new(),
        };
        assert_eq!(
            spec.wrapper_command().as_deref(),
            Some("\"/home/me/GE-Proton/proton\" run")
        );
    }
}
