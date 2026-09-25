//! Find Epic installs on a chosen folder (a portable drive, for example) and
//! register them with legendary. Detection uses the `.egstore/*.mancpn` file
//! Epic writes next to each game. Already-registered games whose saved path
//! is missing are pointed at the folder that was found.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const MAX_DIRS: usize = 4_000;
const MAX_DEPTH: u32 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInstalledResult {
    pub imported: u32,
    pub relinked: u32,
}

/// `(app_name, game directory)` pairs under `root`.
/// `folders` maps a lowercase install-folder name (`FolderName`) to an app name.
/// Some Epic installs only ship a binary `.manifest` inside `.egstore`, with no `.mancpn`.
pub fn scan_installed_folder(root: &Path, folders: &std::collections::HashMap<String, String>) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut budget = MAX_DIRS;
    let start = if root.file_name().and_then(|n| n.to_str()) == Some(".egstore") {
        root.parent().unwrap_or(root)
    } else {
        root
    };
    walk(start, MAX_DEPTH, folders, &mut budget, &mut out);
    out
}

fn folder_index(metadata_dir: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(metadata_dir) else {
        return map;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(app) = val.get("app_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(folder) = val
            .pointer("/metadata/customAttributes/FolderName/value")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        map.insert(folder.to_ascii_lowercase(), app.to_string());
    }
    map
}

fn walk(
    dir: &Path,
    depth: u32,
    folders: &std::collections::HashMap<String, String>,
    budget: &mut usize,
    out: &mut Vec<(String, PathBuf)>,
) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    let egstore = dir.join(".egstore");
    if egstore.is_dir() {
        if let Some(app) = identify_game(dir, &egstore, folders) {
            out.push((app, dir.to_path_buf()));
        }
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip_dir(&name) {
            continue;
        }
        walk(&path, depth - 1, folders, budget, out);
    }
}

fn skip_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "$recycle.bin"
            | "system volume information"
            | "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | ".git"
            | "node_modules"
    )
}

fn identify_game(
    game_dir: &Path,
    egstore: &Path,
    folders: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if let Some(app) = app_name_from_egstore(egstore) {
        return Some(app);
    }
    let has_manifest = std::fs::read_dir(egstore).ok()?.flatten().any(|e| {
        e.path().extension().and_then(|x| x.to_str()) == Some("manifest")
    });
    if !has_manifest {
        return None;
    }
    let name = game_dir.file_name()?.to_str()?.to_ascii_lowercase();
    folders.get(&name).cloned()
}

fn app_name_from_egstore(egstore: &Path) -> Option<String> {
    let entries = std::fs::read_dir(egstore).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("mancpn") {
            continue;
        }
        let text = std::fs::read_to_string(&path).ok()?;
        if let Some(app) = app_name_from_mancpn(&text) {
            return Some(app);
        }
    }
    None
}

fn app_name_from_mancpn(text: &str) -> Option<String> {
    let val: Value = serde_json::from_str(text).ok()?;
    let app = val.get("AppName").and_then(|v| v.as_str()).unwrap_or("").trim();
    if app.is_empty() {
        None
    } else {
        Some(app.to_string())
    }
}

/// Rockstar, EA, and Ubisoft copies on a loose folder are left out of the
/// scan. Epic's own launcher already has a finished install record for some
/// of them, and those stay.
fn keep_scanned_game(app_name: &str, companion: bool, egl_installed: &std::collections::HashSet<String>) -> bool {
    !companion || egl_installed.contains(app_name)
}

fn is_companion_launcher_game(catalog: &Value) -> bool {
    let dev = catalog
        .pointer("/metadata/developer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let attr = |key: &str| {
        catalog
            .pointer(&format!("/metadata/customAttributes/{key}/value"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let third_party = attr("ThirdPartyManagedApp");
    let provider = attr("ThirdPartyManagedProvider");
    let partner = attr("partnerLinkType");
    let registry = attr("RegistryPath");
    let ea = third_party.contains("origin")
        || third_party.contains("ea app")
        || partner == "ea"
        || partner == "origin"
        || registry.contains("ea games")
        || dev.contains("electronic arts");
    let ubisoft = provider.contains("ubisoft")
        || partner.contains("ubisoft")
        || registry.contains("ubisoft")
        || third_party.contains("ubisoft")
        || dev.contains("ubisoft");
    let rockstar = registry.contains("rockstar")
        || third_party.contains("rockstar")
        || dev.contains("rockstar");
    ea || ubisoft || rockstar
}

fn companion_app_names(metadata_dir: &Path) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(metadata_dir) else {
        return names;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !is_companion_launcher_game(&val) {
            continue;
        }
        if let Some(app) = val.get("app_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            names.insert(app.to_string());
        }
    }
    names
}

/// App names Epic Games Launcher already treats as installed. Pending
/// downloads are not included.
fn egl_installed_app_names() -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    let root = super::cache::egl_manifests_dir();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return names;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if val.get("bIsIncompleteInstall").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if let Some(app) = val.get("AppName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            names.insert(app.to_string());
        }
    }
    names
}

fn installed_map(config: &Path) -> serde_json::Map<String, Value> {
    let path = config.join("installed.json");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Registers games found under `root`. `imported` is a new legendary entry.
/// `relinked` is an existing entry whose folder was missing.
pub async fn import_installed_folder(
    app: &AppHandle,
    root: &Path,
) -> Result<ImportInstalledResult, String> {
    if !root.is_dir() {
        return Err("@t:settings.importInstalledMissing".to_string());
    }
    let config = super::skip::default_config_dir();
    let found = tokio::task::spawn_blocking({
        let root = root.to_path_buf();
        let metadata = config.join("metadata");
        move || {
            let folders = folder_index(&metadata);
            scan_installed_folder(&root, &folders)
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let companions = companion_app_names(&config.join("metadata"));
    let egl_installed = egl_installed_app_names();
    let found: Vec<_> = found
        .into_iter()
        .filter(|(app_name, _)| keep_scanned_game(app_name, companions.contains(app_name), &egl_installed))
        .collect();

    let config = super::skip::default_config_dir();
    let mut map = installed_map(&config);
    let settings = crate::load_settings(app);
    let bin = super::paths::resolve_binary(app, settings.alt_legendary_bin.as_deref())
        .map_err(|e| e.to_string())?;

    let mut imported = 0u32;
    let mut relinked = 0u32;
    let mut dirty = false;

    for (app_name, game_dir) in found {
        let path_str = game_dir.to_string_lossy().to_string();
        if let Some(entry) = map.get(&app_name).and_then(|v| v.as_object()) {
            let current = entry
                .get("install_path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if Path::new(current).is_dir() {
                continue;
            }
            if let Some(obj) = map.get_mut(&app_name).and_then(|v| v.as_object_mut()) {
                obj.insert("install_path".to_string(), Value::String(path_str));
                relinked += 1;
                dirty = true;
            }
            continue;
        }

        if run_import(&bin, &app_name, &game_dir).await {
            imported += 1;
        }
    }

    if dirty {
        let file = config.join("installed.json");
        if let Ok(text) = serde_json::to_string_pretty(&map) {
            std::fs::write(file, text).map_err(|e| e.to_string())?;
        }
    }

    Ok(ImportInstalledResult { imported, relinked })
}

async fn run_import(bin: &Path, app_name: &str, game_dir: &Path) -> bool {
    let path = game_dir.to_string_lossy().to_string();
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args([
        "-y",
        "import-game",
        "--disable-check",
        "--skip-dlcs",
        app_name,
        &path,
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd.output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Rockstar's launcher only continues an Epic copy when Epic Games Launcher
/// is the parent process. Point that record at the folder legendary already
/// has, and mark it finished so Epic does not start a second download.
pub fn bind_existing_install(app_name: &str, install_path: &Path) {
    if !install_path.is_dir() {
        return;
    }
    let root = super::cache::egl_manifests_dir();
    for dir in [root.clone(), root.join("Pending")] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(updated) = retarget_item_text(&text, app_name, install_path) else {
                continue;
            };
            let in_pending = dir.ends_with("Pending");
            if in_pending {
                let guid = serde_json::from_str::<Value>(&updated)
                    .ok()
                    .and_then(|v| v.get("InstallationGuid").and_then(|g| g.as_str()).map(|s| s.to_string()))
                    .filter(|s| !s.is_empty());
                if let Some(guid) = guid {
                    let dest = root.join(format!("{guid}.item"));
                    if std::fs::write(&dest, &updated).is_ok() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            } else if updated != text {
                let _ = std::fs::write(&path, updated);
            }
        }
    }
}

/// Rewrites an Epic `.item` so the install location is `install_path` and the
/// record is not an in-progress download. Returns `None` when the app name
/// does not match.
pub fn retarget_item_text(text: &str, app_name: &str, install_path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("AppName").and_then(|v| v.as_str()) != Some(app_name) {
        return None;
    }
    let old = value.get("InstallLocation").and_then(|v| v.as_str()).unwrap_or("");
    let new = install_path.to_string_lossy().replace('/', "\\");
    let mut out = text.to_string();
    if !old.is_empty() && old != new {
        out = out.replace(&old.replace('\\', "\\\\"), &new.replace('\\', "\\\\"));
        out = out.replace(old, &new);
    }
    out = out.replace("\"bIsIncompleteInstall\": true", "\"bIsIncompleteInstall\": false");
    out = out.replace("\"bNeedsValidation\": true", "\"bNeedsValidation\": false");
    Some(out)
}

pub fn epic_launcher_executable() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
        r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
        r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe",
    ];
    candidates.into_iter().map(PathBuf::from).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retarget_points_pending_install_at_the_existing_folder() {
        let raw = r#"{
            "AppName": "Heather",
            "InstallLocation": "C:\\Program Files\\Epic Games\\RedDeadRedemption2",
            "ManifestLocation": "C:\\Program Files\\Epic Games\\RedDeadRedemption2\\.egstore",
            "bIsIncompleteInstall": true,
            "bNeedsValidation": true
        }"#;
        let updated = retarget_item_text(raw, "Heather", Path::new(r"D:\RedDeadRedemption2")).unwrap();
        assert!(updated.contains(r#"D:\\RedDeadRedemption2"#));
        assert!(!updated.contains("Program Files"));
        assert!(updated.contains("\"bIsIncompleteInstall\": false"));
        assert!(updated.contains("\"bNeedsValidation\": false"));
        assert!(retarget_item_text(raw, "Other", Path::new(r"D:\X")).is_none());
    }

    #[test]
    fn companion_games_are_skipped_unless_epic_already_installed_them() {
        let rockstar = serde_json::json!({
            "app_name": "Heather",
            "metadata": { "developer": "Rockstar Games" }
        });
        let ea = serde_json::json!({
            "app_name": "huddle",
            "metadata": {
                "developer": "Electronic Arts",
                "customAttributes": { "ThirdPartyManagedApp": { "value": "Origin" } }
            }
        });
        let ubisoft = serde_json::json!({
            "app_name": "Coriander",
            "metadata": {
                "developer": "Ubisoft Entertainment",
                "customAttributes": { "partnerLinkType": { "value": "ubisoft" } }
            }
        });
        let normal = serde_json::json!({
            "app_name": "Fortnite",
            "app_title": "Rustler - Grand Theft Horse",
            "metadata": { "developer": "Games Operators S.A." }
        });
        assert!(is_companion_launcher_game(&rockstar));
        assert!(is_companion_launcher_game(&ea));
        assert!(is_companion_launcher_game(&ubisoft));
        assert!(!is_companion_launcher_game(&normal));

        let mut installed = std::collections::HashSet::new();
        assert!(!keep_scanned_game("Heather", true, &installed));
        installed.insert("Heather".to_string());
        assert!(keep_scanned_game("Heather", true, &installed));
        assert!(keep_scanned_game("Fortnite", false, &installed));
    }

    #[test]
    fn scan_reads_mancpn_and_skips_windows() {
        let root = std::env::temp_dir().join(format!("efxlve-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let game = root.join("Games").join("RDR2");
        let eg = game.join(".egstore");
        std::fs::create_dir_all(&eg).unwrap();
        std::fs::write(eg.join("game.mancpn"), r#"{"AppName":"Heather"}"#).unwrap();
        std::fs::create_dir_all(root.join("Windows").join("System32").join(".egstore")).unwrap();
        let manifest_game = root.join("UnchartedLOTC");
        let manifest_eg = manifest_game.join(".egstore");
        std::fs::create_dir_all(&manifest_eg).unwrap();
        std::fs::write(manifest_eg.join("abc.manifest"), [0u8, 1, 2]).unwrap();
        let mut folders = std::collections::HashMap::new();
        folders.insert("unchartedlotc".to_string(), "uncharted-app".to_string());
        let found = scan_installed_folder(&root, &folders);
        let via_egstore = scan_installed_folder(&manifest_eg, &folders);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|(app, _)| app == "Heather"));
        assert!(found.iter().any(|(app, _)| app == "uncharted-app"));
        assert_eq!(via_egstore.len(), 1);
        assert_eq!(via_egstore[0].0, "uncharted-app");
    }

    #[test]
    fn mancpn_without_app_name_is_ignored() {
        assert!(app_name_from_mancpn("{}").is_none());
        assert_eq!(app_name_from_mancpn(r#"{"AppName":"Catnip"}"#).as_deref(), Some("Catnip"));
    }
}
