//! Heroic pattern: the library is read from disk FIRST, network sync runs in the background.
//!
//! `metadata/*.json` + `installed.json` + `user.json` are parsed directly,
//! so the UI shows the cache even when the Epic API fails.
//! The on-disk format matches `list --json` output (`Game.__dict__`).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::models::{InstalledGame, LegendaryGame};

#[derive(Debug, Clone, Default, Deserialize)]
struct UserFile {
    // CAUTION: user.json keys are snake_case (account_id),
    // a wrong rename + #[serde(default)] silently yields an empty string!
    #[serde(default)]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
}

/// When signed in (display name, account_id); the profile URL is built from the id:
/// `https://store.epicgames.com/u/<account_id>`
pub fn read_user(config: &Path) -> Option<(String, Option<String>)> {
    let text = std::fs::read_to_string(config.join("user.json")).ok()?;
    let u: UserFile = serde_json::from_str(&text).ok()?;
    let name = u.display_name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let id = u.account_id.trim().to_string();
    Some((name, if id.is_empty() { None } else { Some(id) }))
}

/// Single-file snapshot of the (already slimmed) library.
///
/// Reading and parsing ~900 individual metadata files on a cold start can take
/// seconds on an HDD. This consolidated file lets the UI paint the library
/// almost instantly; the background sync refreshes it.
///
/// The file carries a version stamp: when [`slim_game`] starts dropping a field
/// the reader slims the old payload once and writes it back, so a release never
/// ships a stale shape (and never falls back to walking `metadata/*.json`).
fn snapshot_path(config: &Path) -> std::path::PathBuf {
    config.join("efxlve_library_snapshot.json")
}

/// Bump when `slim_game` drops something the old file still carries.
const SNAPSHOT_VERSION: u32 = 3;

#[derive(Serialize, Deserialize)]
struct LibrarySnapshot {
    version: u32,
    games: Vec<LegendaryGame>,
}

pub fn write_library_snapshot(config: &Path, games: &[LegendaryGame]) {
    let snapshot = LibrarySnapshot {
        version: SNAPSHOT_VERSION,
        games: games.to_vec(),
    };
    if let Ok(json) = serde_json::to_string(&snapshot) {
        let _ = std::fs::write(snapshot_path(config), json);
    }
}

pub fn read_library_snapshot(config: &Path) -> Option<Vec<LegendaryGame>> {
    if let Ok(text) = std::fs::read_to_string(snapshot_path(config)) {
        if let Ok(snapshot) = serde_json::from_str::<LibrarySnapshot>(&text) {
            if snapshot.version == SNAPSHOT_VERSION {
                return Some(snapshot.games);
            }
            return Some(reslim(config, snapshot.games));
        }
        // Older releases wrote a bare array; slim it into the stamped shape.
        if let Ok(games) = serde_json::from_str::<Vec<LegendaryGame>>(&text) {
            return Some(reslim(config, games));
        }
        return None;
    }
    migrate_legacy_snapshot(config)
}

/// Applies the current `slim_game` to an outdated payload and rewrites the file.
fn reslim(config: &Path, mut games: Vec<LegendaryGame>) -> Vec<LegendaryGame> {
    for game in games.iter_mut() {
        super::models::slim_game(game);
    }
    write_library_snapshot(config, &games);
    games
}

/// One-time hop from the pre-versioning files (`_v2`, then the original name).
fn migrate_legacy_snapshot(config: &Path) -> Option<Vec<LegendaryGame>> {
    for legacy in [
        config.join("efxlve_library_snapshot_v2.json"),
        config.join("efxlve_library_snapshot_v1.json"),
    ] {
        if !legacy.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&legacy) else {
            continue;
        };
        let Ok(games) = serde_json::from_str::<Vec<LegendaryGame>>(&text) else {
            continue;
        };
        let games = reslim(config, games);
        let _ = std::fs::remove_file(&legacy);
        return Some(games);
    }
    None
}

/// All game metadata in the cache (broken files are skipped).
pub fn read_cached_games(config: &Path) -> Vec<LegendaryGame> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(config.join("metadata")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(mut g) = serde_json::from_str::<LegendaryGame>(&text) {
                if !g.app_name.is_empty() {
                    super::models::slim_game(&mut g);
                    out.push(g);
                }
            }
        }
    }
    out.sort_by(|a, b| a.app_title.to_lowercase().cmp(&b.app_title.to_lowercase()));
    out
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EglDetectedGame {
    pub app_name: String,
    pub title: String,
    pub install_path: String,
    pub executable: String,
    pub version: String,
    pub install_size: u64,
}

/// Path to the Epic Games Launcher Data/Manifests folder.
pub fn egl_manifests_dir() -> std::path::PathBuf {
    if let Ok(pd) = std::env::var("ProgramData") {
        let p = Path::new(&pd)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests");
        if p.is_dir() {
            return p;
        }
    }
    std::path::PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests")
}

/// Unreal Engine, Fab plugins and Quixel Bridge install through the Epic Games
/// Launcher too, but they are tools and assets, not games. Their manifests
/// carry the `ue` catalog namespace; the name checks cover older manifests
/// written before that field existed.
fn is_game_manifest(val: &serde_json::Value) -> bool {
    let text = |key: &str| {
        val.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
    };
    if text("CatalogNamespace").eq_ignore_ascii_case("ue") {
        return false;
    }
    let app = text("AppName").to_ascii_lowercase();
    if app == "unrealengine" || app.starts_with("ue_") {
        return false;
    }
    let title = text("DisplayName").to_ascii_lowercase();
    !(title.starts_with("unreal engine") || title == "fab ue plugin" || title.starts_with("quixel"))
}

/// One detection source with the time its record was written. A game usually
/// has more than one source (a manifest plus the v2 transaction log); the newer
/// record owns the build path and version, while the first real display name
/// wins over the folder-name fallback.
struct EglCandidate {
    game: EglDetectedGame,
    written: Option<std::time::SystemTime>,
    /// The source carries a display name (a manifest), not just a folder name.
    named: bool,
}

/// One manifest directory pass. Alongside the games it reports the tool and
/// asset app names, so rows older releases already imported can be pruned.
fn scan_manifest_dir(dir: &Path) -> (Vec<EglCandidate>, Vec<String>) {
    if !dir.is_dir() {
        return (Vec::new(), Vec::new());
    }
    let mut out = Vec::new();
    let mut tools = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                let app_name = val
                    .get("AppName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if !is_game_manifest(&val) {
                    if !app_name.is_empty() {
                        tools.push(app_name.to_string());
                    }
                    continue;
                }
                // Skip DLC entries and keep the main games only.
                let main_game = val
                    .get("MainGameAppName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if !main_game.is_empty() {
                    continue;
                }
                let install_loc = val
                    .get("InstallLocation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if install_loc.is_empty() || !Path::new(install_loc).exists() {
                    continue;
                }
                let title = val
                    .get("DisplayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let executable = val
                    .get("LaunchExecutable")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                // If a launch executable is specified, verify it exists. If it does not,
                // the game files are missing or incomplete (EGL would show "Repair").
                if !executable.is_empty() && !Path::new(install_loc).join(executable).exists() {
                    continue;
                }
                let version = val
                    .get("AppVersionString")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let install_size = val.get("InstallSize").and_then(|v| v.as_u64()).unwrap_or(0);

                if !app_name.is_empty() && !title.is_empty() {
                    out.push(EglCandidate {
                        game: EglDetectedGame {
                            app_name: app_name.to_string(),
                            title: title.to_string(),
                            install_path: install_loc.to_string(),
                            executable: executable.to_string(),
                            version: version.to_string(),
                            install_size,
                        },
                        written: std::fs::metadata(&path)
                            .and_then(|meta| meta.modified())
                            .ok(),
                        named: true,
                    });
                }
            }
        }
    }
    (out, tools)
}

/// Per-user data folder of the rebuilt Epic Games Launcher (v2).
fn egl_v2_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = std::path::PathBuf::from(base).join("com.epicgames.eglv2");
    dir.is_dir().then_some(dir)
}

/// One installation record from the v2 `installations.jsonl` transaction log.
/// The first line only carries the log version, a later line for the same
/// installation replaces the earlier one, and a write can land mid-line.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EglV2Installation {
    #[serde(default)]
    installation_id: String,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    artifact_id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    launch_executable: String,
    #[serde(default)]
    parent_installation_id: String,
}

/// The v2 launcher's measured install sizes, keyed by app name.
#[derive(Debug, Default, Deserialize)]
struct EglV2SizeCache {
    #[serde(default)]
    entries: Vec<EglV2SizeEntry>,
}

#[derive(Debug, Default, Deserialize)]
struct EglV2SizeEntry {
    #[serde(default)]
    app_id: EglV2SizeApp,
    #[serde(default)]
    bytes: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EglV2SizeApp {
    #[serde(default)]
    app_name: String,
}

fn egl_v2_sizes(dir: &Path) -> HashMap<String, u64> {
    let path = dir.join("cache").join("disk-size-cache.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(cache) = serde_json::from_str::<EglV2SizeCache>(&text) else {
        return HashMap::new();
    };
    cache
        .entries
        .into_iter()
        .filter(|entry| !entry.app_id.app_name.is_empty() && entry.bytes > 0.0)
        .map(|entry| {
            (
                entry.app_id.app_name.to_ascii_lowercase(),
                entry.bytes as u64,
            )
        })
        .collect()
}

/// Games the rebuilt Epic Games Launcher records as installed. It stopped
/// writing the old `ProgramData/.../Manifests` folder, so without this pass the
/// launcher is detected while its games look like nothing to import.
fn read_egl_v2_installations(dir: &Path) -> (Vec<EglCandidate>, Vec<String>) {
    let path = ["installations.jsonl", "installations.jsonl.prev"]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file());
    let Some(path) = path else {
        return (Vec::new(), Vec::new());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (Vec::new(), Vec::new());
    };
    let written = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok();
    let mut records: HashMap<String, EglV2Installation> = HashMap::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<EglV2Installation>(line) else {
            continue;
        };
        if !record.installation_id.is_empty() {
            records.insert(record.installation_id.clone(), record);
        }
    }
    let sizes = egl_v2_sizes(dir);
    let mut games = Vec::new();
    let mut tools = Vec::new();
    for record in records.into_values() {
        // Add-ons share the main game's folder and must not become rows.
        if !record.parent_installation_id.is_empty() {
            continue;
        }
        if record.namespace.eq_ignore_ascii_case("ue") {
            if !record.artifact_id.is_empty() {
                tools.push(record.artifact_id.clone());
            }
            continue;
        }
        let install = record.dir.trim();
        let app_name = record.artifact_id.trim();
        if install.is_empty() || app_name.is_empty() || !Path::new(install).is_dir() {
            continue;
        }
        let executable = record.launch_executable.trim();
        // A record survives a manual folder move; only a folder that still holds
        // the build is importable.
        if !executable.is_empty() && !Path::new(install).join(executable).is_file() {
            continue;
        }
        if executable.is_empty() && !Path::new(install).join(".egstore").is_dir() {
            continue;
        }
        let title = Path::new(install)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(app_name);
        games.push(EglCandidate {
            game: EglDetectedGame {
                app_name: app_name.to_string(),
                title: title.to_string(),
                install_path: install.to_string(),
                executable: executable.to_string(),
                version: record.version.trim().to_string(),
                install_size: sizes
                    .get(&app_name.to_ascii_lowercase())
                    .copied()
                    .unwrap_or(0),
            },
            written,
            named: false,
        });
    }
    (games, tools)
}

/// Folds one sighting into the app's row. The first real display name wins;
/// the newest record owns the install path and version.
fn merge_egl_candidate(
    out: &mut Vec<EglCandidate>,
    seen: &mut HashMap<String, usize>,
    candidate: EglCandidate,
) {
    let key = candidate.game.app_name.to_ascii_lowercase();
    let Some(&position) = seen.get(&key) else {
        seen.insert(key, out.len());
        out.push(candidate);
        return;
    };
    let existing = &mut out[position];
    let newer = match (candidate.written, existing.written) {
        (Some(new), Some(old)) => new > old,
        (Some(_), None) => true,
        _ => false,
    };
    if candidate.named && !existing.named {
        existing.game.title = candidate.game.title;
        existing.named = true;
    } else if existing.game.title.is_empty() {
        existing.game.title = candidate.game.title;
        existing.named |= candidate.named;
    }
    if newer {
        if !candidate.game.install_path.is_empty() {
            existing.game.install_path = candidate.game.install_path;
        }
        if !candidate.game.executable.is_empty() {
            existing.game.executable = candidate.game.executable;
        }
        if !candidate.game.version.is_empty() {
            existing.game.version = candidate.game.version;
        }
        if candidate.game.install_size > 0 {
            existing.game.install_size = candidate.game.install_size;
        }
        existing.written = candidate.written;
    } else {
        if existing.game.install_path.is_empty() && !candidate.game.install_path.is_empty() {
            existing.game.install_path = candidate.game.install_path;
        }
        if existing.game.executable.is_empty() && !candidate.game.executable.is_empty() {
            existing.game.executable = candidate.game.executable;
        }
        if existing.game.version.is_empty() && !candidate.game.version.is_empty() {
            existing.game.version = candidate.game.version;
        }
        if existing.game.install_size == 0 && candidate.game.install_size > 0 {
            existing.game.install_size = candidate.game.install_size;
        }
    }
}

/// Every game the official Epic Games Launcher has installed, across the legacy
/// `ProgramData` manifests and the rebuilt launcher's per-user records.
fn scan_egl_manifests() -> (Vec<EglDetectedGame>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut seen = HashMap::new();
    let mut tools = Vec::new();

    // The rebuilt launcher keeps its own manifests (when it writes them), the
    // v1 .item files it archived during import, and the live transaction log.
    // The log has no display name, so the manifest passes run first.
    if let Some(dir) = egl_v2_dir() {
        for manifests in [
            dir.join("manifests"),
            dir.join("import-scan").join("v1-items"),
        ] {
            let (found, found_tools) = scan_manifest_dir(&manifests);
            for candidate in found {
                merge_egl_candidate(&mut candidates, &mut seen, candidate);
            }
            tools.extend(found_tools);
        }
        let (found, found_tools) = read_egl_v2_installations(&dir);
        for candidate in found {
            merge_egl_candidate(&mut candidates, &mut seen, candidate);
        }
        tools.extend(found_tools);
    }

    // Releases before the rebuild still write here.
    let (found, found_tools) = scan_manifest_dir(&egl_manifests_dir());
    for candidate in found {
        merge_egl_candidate(&mut candidates, &mut seen, candidate);
    }
    tools.extend(found_tools);

    (
        candidates.into_iter().map(|candidate| candidate.game).collect(),
        tools,
    )
}

/// Scans main games installed in the Epic Games Launcher and present on disk.
pub fn read_egl_installed_games() -> Vec<EglDetectedGame> {
    scan_egl_manifests().0
}

/// Deletes all EGL .item manifests in ProgramData for this game (and any of its DLCs).
/// Without this, official Epic Games Store displays "Repair" instead of returning to
/// the uninstalled state, and our launcher re-detects the game on refresh.
pub fn remove_egl_manifests_for_game(app_name: &str) {
    let dir = egl_manifests_dir();
    if !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                let matches_app = val
                    .get("AppName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case(app_name))
                    .unwrap_or(false);
                let matches_main = val
                    .get("MainGameAppName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case(app_name))
                    .unwrap_or(false);
                if matches_app || matches_main {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// Explicitly removes a game from legendary's installed.json.
pub fn remove_game_from_installed_json(config: &Path, app_name: &str) {
    let installed_file = config.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(mut map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&text) {
            let before_len = map.len();
            map.retain(|k, _| !k.eq_ignore_ascii_case(app_name));
            if map.len() != before_len {
                if let Some(json_str) = ascii_json_pretty(&map) {
                    let _ = std::fs::write(&installed_file, json_str);
                }
            }
        }
    }
}

/// Removes cached manifest files and custom game settings for an uninstalled game.
pub fn remove_game_manifests(config: &Path, app_name: &str) {
    let manifests_dir = config.join("manifests");
    if manifests_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(manifests_dir) {
            let prefix = format!("{}_", app_name.to_lowercase());
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(file_name) = p.file_name().and_then(|n| n.to_str()) {
                    if file_name.to_lowercase().starts_with(&prefix) {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
        }
    }
    let game_settings = config
        .join("game_settings")
        .join(format!("{app_name}.json"));
    if game_settings.is_file() {
        let _ = std::fs::remove_file(game_settings);
    }
}

/// Copies the manifest of EGL-installed games from the .egstore folder to the legendary manifests dir
pub fn ensure_egl_manifest(
    config: &Path,
    app_name: &str,
    install_path: &str,
    version: &str,
    platform: &str,
) {
    let manifests_dir = config.join("manifests");
    let _ = std::fs::create_dir_all(&manifests_dir);
    let target_name = format!("{}_{}_{}.manifest", app_name, platform, version);
    let target_file = manifests_dir.join(&target_name);
    if target_file.exists() {
        return;
    }
    let egstore = Path::new(install_path).join(".egstore");
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(egstore) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("manifest") {
                continue;
            }
            let Ok(meta) = p.metadata() else {
                continue;
            };
            // A stub manifest cannot describe a build; the real ones are megabytes.
            if meta.len() <= 1024 {
                continue;
            }
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            if newest.as_ref().is_none_or(|(best, _)| modified > *best) {
                newest = Some((modified, p));
            }
        }
    }
    // An update can leave more than one manifest behind; the newest one is the
    // build the launcher actually left on disk, which is the diff base a later
    // legendary update must use.
    if let Some((_, manifest)) = newest {
        let _ = std::fs::copy(&manifest, &target_file);
    }
}

/// Follows an EGL update into installed.json right before a download starts.
///
/// EGL can update a game while this window is open, so the library refresh that
/// normally records its version may not have run yet. legendary diffs an update
/// against the build installed.json names; a stale base means patching files
/// that no longer match it.
pub fn refresh_installed_from_egl(config: &Path, app_name: &str) -> bool {
    let Some(egl) = scan_egl_manifests()
        .0
        .into_iter()
        .find(|g| g.app_name.eq_ignore_ascii_case(app_name))
    else {
        return false;
    };
    ensure_egl_manifest(
        config,
        &egl.app_name,
        &egl.install_path,
        &egl.version,
        "Windows",
    );
    let installed_file = config.join("installed.json");
    let stamp = installed_stamp(config);
    let Ok(text) = std::fs::read_to_string(&installed_file) else {
        return false;
    };
    let Ok(mut map) = serde_json::from_str::<HashMap<String, InstalledGame>>(&text) else {
        return false;
    };
    if merge_egl_record(&mut map, &egl) == EglMerge::Unchanged {
        return false;
    }
    if crate::legendary::transfers::transfer_active() {
        return false;
    }
    write_installed_map_if_unchanged(config, stamp, &map)
}

/// How one Epic Games Launcher manifest changed installed.json.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EglMerge {
    /// The app was not tracked before and got a fresh record.
    Added,
    /// The record existed but its version (or size) followed EGL.
    Updated,
    Unchanged,
}

/// Epic sometimes stores a build's file name where a version belongs
/// (`DBD_Vanilla_HFL_EGS_Shipping_9_3871532_10.2.0.7`). The list shows the
/// version, and comparing these keeps a rename from looking like an update.
pub fn display_version(raw: &str) -> String {
    let mut value = raw.trim();
    // EGL appends the platform to `AppVersionString`; the catalog build version
    // usually does not. They name the same build, so a suffix alone must not
    // read as a pending update (Fortnite writes `...-Windows`).
    let lower = value.to_ascii_lowercase();
    for suffix in ["-windows", "-win64", "-win32", "-mac", "-linux"] {
        if value.len() > suffix.len() && lower.ends_with(suffix) {
            value = value[..value.len() - suffix.len()].trim_end();
            break;
        }
    }
    if value.is_empty() {
        return String::new();
    }
    if value.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return value.to_string();
    }
    // The trailing number group is the version in every artifact name seen.
    value
        .rsplit('_')
        .next()
        .filter(|tail| tail.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// Same folder, spelled the way the two launchers happen to write it.
fn same_install_path(left: &str, right: &str) -> bool {
    let trim = |s: &str| {
        s.trim()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase()
    };
    let (left, right) = (trim(left), trim(right));
    !left.is_empty() && left == right
}

/// Whether EGL's `.item` build should replace the version in installed.json.
///
/// EGL writes its manifest when it installs or updates a game, so its record
/// describes the files on disk and is the only safe diff base for legendary.
/// The catalog build version is used to prompt for an update, never to decide
/// which on-disk record to trust.
fn egl_version_wins(installed: &str, egl: &str) -> bool {
    let egl = egl.trim();
    !egl.is_empty() && installed.trim() != egl
}

/// Applies one EGL manifest to the installed map: imports the game when it is
/// unknown, otherwise follows EGL's version.
pub fn merge_egl_record(
    map: &mut HashMap<String, InstalledGame>,
    egl: &EglDetectedGame,
) -> EglMerge {
    let Some(existing) = map.get_mut(&egl.app_name) else {
        map.insert(
            egl.app_name.clone(),
            InstalledGame {
                app_name: egl.app_name.clone(),
                title: egl.title.clone(),
                version: egl.version.clone(),
                install_path: egl.install_path.clone(),
                install_size: egl.install_size,
                executable: egl.executable.clone(),
                can_run_offline: true,
                egl_guid: String::new(),
                launch_parameters: String::new(),
                manifest_path: String::new(),
                needs_verification: false,
                platform: "Windows".to_string(),
                prereq_info: None,
                uninstaller: None,
                requires_ot: false,
                save_path: None,
                is_preloaded: false,
                is_dlc: false,
                base_urls: vec![],
                install_tags: vec![],
            },
        );
        return EglMerge::Added;
    };
    // A different folder is a second copy; legendary's record still owns its own.
    if !same_install_path(&existing.install_path, &egl.install_path)
        || !egl_version_wins(&existing.version, &egl.version)
    {
        return EglMerge::Unchanged;
    }
    existing.version = egl.version.clone();
    if egl.install_size > 0 {
        existing.install_size = egl.install_size;
    }
    EglMerge::Updated
}

#[cfg(windows)]
fn query_registry_path(reg_path: &str, reg_key: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // The Win32 registry API instead of `reg query`: every probe used to be a
    // process spawn (~30 ms each, 0.47 s for the boot path's two dozen probes).
    let subkey = wide(reg_path);
    let value_name = wide(reg_key);
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            None,
            KEY_READ,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        let sized = RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        ) == ERROR_SUCCESS
            && size > 0;
        if !sized || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
            let _ = RegCloseKey(key);
            return None;
        }
        let mut buffer = vec![0u16; size as usize / 2 + 1];
        let mut read = size;
        let ok = RegQueryValueExW(
            key,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr() as *mut u8),
            Some(&mut read),
        ) == ERROR_SUCCESS;
        let _ = RegCloseKey(key);
        if !ok {
            return None;
        }
        let text = String::from_utf16_lossy(&buffer);
        let text = text.trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    }
}

#[cfg(not(windows))]
fn query_registry_path(_reg_path: &str, _reg_key: &str) -> Option<String> {
    None
}

/// Scans the registry for games handed off to third-party launchers (Ubisoft Connect, EA App).
///
/// Only an entry's `customAttributes` decides whether it is a candidate, and walking
/// `metadata/*.json` to rebuild that for ~800 games costs seconds on the boot path
/// (measured: 3.0 s for 820 files). A caller that already holds the parsed catalog —
/// the library snapshot — passes it in; the directory walk stays as the fallback for
/// the first run, before any snapshot exists.
pub fn read_third_party_installed_games(
    config: &Path,
    already_installed: &HashMap<String, InstalledGame>,
    catalog: Option<&[LegendaryGame]>,
) -> Vec<InstalledGame> {
    let candidates: Vec<(String, String, Option<Value>)> = match catalog {
        Some(games) => games
            .iter()
            .map(|g| {
                (
                    g.app_name.trim().to_string(),
                    g.app_title.trim().to_string(),
                    g.metadata.get("customAttributes").cloned(),
                )
            })
            .collect(),
        None => metadata_candidates(config),
    };

    // Only entries that declare a registry location can be installed by another
    // launcher; everything else is dropped before any work happens.
    let jobs: Vec<(String, String, Option<Value>)> = candidates
        .into_iter()
        .filter(|(app_name, _, _)| {
            !app_name.is_empty() && !already_installed.contains_key(app_name)
        })
        .collect();

    // The registry probes used to be `reg query` process spawns and needed a
    // thread fan-out to stay under a second; with the Win32 registry API they
    // are microseconds, so a plain loop is simpler and faster.
    let probes: Vec<Option<String>> = jobs
        .iter()
        .map(|(_, _, attrs)| attrs.as_ref().and_then(probe_install_location))
        .collect();

    let mut out = Vec::new();
    for ((app_name, title, _), install_path) in jobs.into_iter().zip(probes) {
        let Some(install_path) = install_path else {
            continue;
        };
        out.push(InstalledGame {
            title: if title.is_empty() {
                app_name.clone()
            } else {
                title
            },
            app_name,
            version: "1.0".to_string(),
            install_path,
            install_size: 0,
            executable: String::new(),
            can_run_offline: true,
            egl_guid: String::new(),
            launch_parameters: String::new(),
            manifest_path: String::new(),
            needs_verification: false,
            platform: "Windows".to_string(),
            prereq_info: None,
            uninstaller: None,
            requires_ot: false,
            save_path: None,
            is_preloaded: false,
            is_dlc: false,
            base_urls: vec![],
            install_tags: vec![],
        });
    }

    out
}

/// Install folder declared by a catalog entry's registry attributes, when the key
/// exists and still points at a folder on disk.
fn probe_install_location(attrs: &Value) -> Option<String> {
    let reg_path = attrs
        .get("RegistryPath")
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let reg_key = attrs
        .get("RegistryKey")
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if reg_path.is_empty() || reg_key.is_empty() {
        return None;
    }
    let install_path = query_registry_path(reg_path, reg_key)?;
    Path::new(&install_path).is_dir().then_some(install_path)
}

/// Fallback candidate source for `read_third_party_installed_games`: the raw
/// `metadata/*.json` files, used only until a library snapshot exists.
fn metadata_candidates(config: &Path) -> Vec<(String, String, Option<Value>)> {
    let mut out = Vec::new();
    let meta_dir = config.join("metadata");
    let Ok(entries) = std::fs::read_dir(meta_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let app_name = val
            .get("app_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if app_name.is_empty() {
            continue;
        }
        let title = val
            .get("app_title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let attrs = val
            .get("metadata")
            .and_then(|m| m.get("customAttributes"))
            .cloned();
        out.push((app_name.to_string(), title.to_string(), attrs));
    }
    out
}

/// The install tags legendary recorded for one game. A cheap read for callers
/// that only need the selection (a download start must not scan the catalog).
pub fn installed_install_tags(config: &Path, app_name: &str) -> Vec<String> {
    std::fs::read_to_string(config.join("installed.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, InstalledGame>>(&text).ok())
        .and_then(|mut map| map.remove(app_name))
        .map(|game| game.install_tags)
        .unwrap_or_default()
}

/// Read installed games: installed.json + EGL manifests + third-party registry.
pub fn read_installed(config: &Path) -> Vec<InstalledGame> {
    // Third-party detection wants the catalog, and the snapshot is the consolidated
    // copy of it: parsing that one file (~0.35 s for 820 games) is much cheaper than
    // walking `metadata/*.json` (~1.6 s measured). The walk stays as the fallback for
    // a first run, before any snapshot exists.
    let snapshot = read_library_snapshot(config);
    read_installed_with_catalog(config, snapshot.as_deref(), None)
}

fn installed_backup_path(config: &Path) -> std::path::PathBuf {
    config.join("installed.json.bak")
}

/// Identity of installed.json at one moment: size and mtime.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct InstalledStamp(Option<(u64, Option<std::time::SystemTime>)>);

pub(crate) fn installed_stamp(config: &Path) -> InstalledStamp {
    let meta = std::fs::metadata(config.join("installed.json")).ok();
    InstalledStamp(meta.map(|meta| (meta.len(), meta.modified().ok())))
}

/// Writes only when no other launcher changed installed.json since `stamp`.
/// Another legendary (Heroic, the CLI) keeps its own map in memory and writes
/// it at the end; skipping our stale copy keeps its new record alive.
pub(crate) fn write_installed_map_if_unchanged(
    config: &Path,
    stamp: InstalledStamp,
    map: &HashMap<String, InstalledGame>,
) -> bool {
    if installed_stamp(config) != stamp {
        return false;
    }
    write_installed_map(config, map);
    true
}

/// Serializes a store file the way legendary's Python writer does: ASCII only,
/// with every non-ASCII character escaped.
///
/// Python opens `installed.json` with the system code page. On a Turkish
/// Windows the page is cp1254, where a literal "™" from a title makes the whole
/// file undecodable and legendary reports zero installed games. Its own writer
/// avoids this with `json.dump(..., ensure_ascii=True)`, so match that.
pub(crate) fn ascii_json_pretty<T: Serialize>(value: &T) -> Option<String> {
    let text = serde_json::to_string_pretty(value).ok()?;
    Some(escape_non_ascii(&text))
}

fn escape_non_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if (ch as u32) < 0x80 {
            out.push(ch);
            continue;
        }
        let mut units = [0u16; 2];
        for unit in ch.encode_utf16(&mut units) {
            out.push_str(&format!("\\u{unit:04x}"));
        }
    }
    out
}

/// Writes installed.json through a temporary file and keeps the previous
/// contents as `installed.json.bak`.
///
/// A reader never sees a half-written map, and a truncated file can be
/// recovered from the backup on the next read.
pub(crate) fn write_installed_map(config: &Path, map: &HashMap<String, InstalledGame>) {
    let Some(json) = ascii_json_pretty(map) else {
        return;
    };
    let path = config.join("installed.json");
    let tmp = config.join("installed.json.tmp");
    if std::fs::metadata(&path)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
    {
        let _ = std::fs::copy(&path, installed_backup_path(config));
    }
    if std::fs::write(&tmp, json).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    // `rename` replaces the destination on Windows too (MOVEFILE_REPLACE_EXISTING).
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// One timing line per phase, only when a boot path asked for it.
fn mark(app: Option<&tauri::AppHandle>, label: &str, started: std::time::Instant) {
    if let Some(app) = app {
        crate::perf::write_line(
            app,
            &format!("{:>6} ms  {label}", started.elapsed().as_millis()),
        );
    }
}

/// `read_installed` with an already-parsed catalog: see
/// `read_third_party_installed_games` for why the boot path passes the snapshot in.
pub fn read_installed_with_catalog(
    config: &Path,
    catalog: Option<&[LegendaryGame]>,
    app: Option<&tauri::AppHandle>,
) -> Vec<InstalledGame> {
    let t_installed = std::time::Instant::now();
    let installed_file = config.join("installed.json");
    let mut map: HashMap<String, InstalledGame> = HashMap::new();
    // legendary rewrites installed.json while an install runs, so a read can
    // land mid-write. Never overwrite a file this pass could not read: the map
    // would only hold what the EGL scan rebuilt, losing legendary's records.
    // A truncated file falls back to the last good copy.
    let stamp_before = installed_stamp(config);
    let mut recovered = false;
    let writable = match std::fs::read_to_string(&installed_file) {
        Ok(text) => match serde_json::from_str::<HashMap<String, InstalledGame>>(&text) {
            Ok(loaded) => {
                map = loaded;
                true
            }
            Err(_) => match std::fs::read_to_string(installed_backup_path(config))
                .ok()
                .and_then(|text| serde_json::from_str::<HashMap<String, InstalledGame>>(&text).ok())
            {
                Some(loaded) => {
                    eprintln!("[installed] installed.json is corrupt; using installed.json.bak");
                    map = loaded;
                    recovered = true;
                    true
                }
                None => false,
            },
        },
        // No file yet (first run): nothing to clobber.
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    };
    let stamp = installed_stamp(config);
    // A file that changed while it was being read is another writer's; do not
    // write our snapshot back over it.
    let stable = stamp_before == stamp;
    // Our own transfer keeps legendary's map in memory and writes it when the
    // process exits; a write here would lose the record it is about to commit.
    let writable = writable && stable && !crate::legendary::transfers::transfer_active();
    mark(app, "rust:installed/json", t_installed);

    let mut changed = false;

    // Prune stale entries whose install directory no longer exists on a mounted drive.
    let t_prune = std::time::Instant::now();
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        if let Some(game) = map.get(&key) {
            let path_str = game.install_path.trim();
            if !path_str.is_empty() {
                let p = Path::new(path_str);
                if p.is_absolute() {
                    let drive_present = p
                        .components()
                        .next()
                        .map(|c| Path::new(&c).exists())
                        .unwrap_or(false);
                    if drive_present && !p.exists() {
                        map.remove(&key);
                        changed = true;
                    }
                }
            }
        }
    }

    // 1. Read the Epic Games Launcher manifests: import the missing games and
    // follow a version an EGL update left behind
    mark(app, "rust:installed/prune", t_prune);
    let t_egl = std::time::Instant::now();
    let (egl_games, egl_tools) = scan_egl_manifests();
    // Unreal Engine, Fab and Quixel were imported as games by older releases;
    // drop those rows so the library stops listing them.
    for app_name in &egl_tools {
        if map.remove(app_name).is_some() {
            changed = true;
        }
    }
    for egl in egl_games {
        ensure_egl_manifest(
            config,
            &egl.app_name,
            &egl.install_path,
            &egl.version,
            "Windows",
        );
        if merge_egl_record(&mut map, &egl) != EglMerge::Unchanged {
            changed = true;
        }
    }

    // Auto-sync: persist imported games and version changes into installed.json
    if (changed || recovered) && writable {
        write_installed_map_if_unchanged(config, stamp, &map);
    }

    // 2. Detect games installed via third-party launchers (Ubisoft Connect, EA, ...) from the registry
    // CAUTION: third-party games are NOT persisted to installed.json! (no legendary manifest -> python TypeError)
    mark(app, "rust:installed/egl", t_egl);
    let t_third = std::time::Instant::now();
    let mut extra_tp = Vec::new();
    for tp in read_third_party_installed_games(config, &map, catalog) {
        if !map.contains_key(&tp.app_name) {
            extra_tp.push(tp);
        }
    }
    mark(app, "rust:installed/third-party", t_third);

    let mut v: Vec<_> = map.into_values().collect();
    v.extend(extra_tp);
    v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    v
}

/// Rewrites `installed.json`'s `install_size` from the files on disk.
///
/// legendary records the byte count of the last operation, not the size of the
/// whole install: an update or a paused-then-resumed download reports only the
/// remaining bytes. The manage panel labels the number as the installed disk
/// size, so measure the folder instead of trusting that delta.
pub fn refresh_installed_size(config: &Path, app_name: &str) -> bool {
    let installed_file = config.join("installed.json");
    let stamp = installed_stamp(config);
    let Ok(text) = std::fs::read_to_string(&installed_file) else {
        return false;
    };
    let Ok(mut map) =
        serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
    else {
        return false;
    };
    let Some(key) = map
        .keys()
        .find(|key| key.eq_ignore_ascii_case(app_name))
        .cloned()
    else {
        return false;
    };
    let Some(entry) = map.get_mut(&key) else {
        return false;
    };
    if entry.install_path.trim().is_empty() {
        return false;
    }
    let bytes = crate::storage_usage::dir_size(Path::new(&entry.install_path), 0);
    if bytes == 0 || bytes == entry.install_size {
        return false;
    }
    entry.install_size = bytes;
    write_installed_map_if_unchanged(config, stamp, &map)
}

/// Copies legendary's freshly installed version and size into the Epic Games
/// Launcher `.item` for this app (and any of its DLCs).
///
/// EGL decides "update available" by comparing the `.item`'s `AppVersionString`
/// with the catalog. legendary rewrites `installed.json` but never touches the
/// `.item`, so without this sync the official launcher offers the very same
/// update again right after this launcher already installed it.
pub fn sync_egl_manifest_version(config: &Path, app_name: &str) {
    let dir = egl_manifests_dir();
    if !dir.is_dir() {
        return;
    }
    let installed = read_installed(config);
    let find = |name: &str| {
        installed
            .iter()
            .find(|g| g.app_name.eq_ignore_ascii_case(name))
    };
    let Some(main) = find(app_name) else {
        return;
    };
    let main_version = main.version.clone();
    let main_size = main.install_size;

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        let item_app = val
            .get("AppName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let main_of_item = val
            .get("MainGameAppName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        let (version, size) = if item_app.eq_ignore_ascii_case(app_name) {
            (main_version.clone(), main_size)
        } else if main_of_item.eq_ignore_ascii_case(app_name) {
            match find(&item_app) {
                Some(dlc) => (dlc.version.clone(), dlc.install_size),
                None => continue,
            }
        } else {
            continue;
        };

        if apply_installed_version(&mut val, &version, size) {
            if let Ok(new_text) = serde_json::to_string_pretty(&val) {
                let _ = std::fs::write(&path, new_text);
            }
        }
    }
}

/// Writes the installed version/size into one `.item` object. Returns true when
/// a field actually changed. Split out so it can be unit-tested without EGL.
fn apply_installed_version(val: &mut serde_json::Value, version: &str, install_size: u64) -> bool {
    let Some(obj) = val.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if !version.is_empty() && obj.get("AppVersionString").and_then(|v| v.as_str()) != Some(version)
    {
        obj.insert(
            "AppVersionString".to_string(),
            serde_json::Value::String(version.to_string()),
        );
        changed = true;
    }
    if obj.get("InstallSize").and_then(|v| v.as_u64()) != Some(install_size) {
        obj.insert(
            "InstallSize".to_string(),
            serde_json::Value::from(install_size),
        );
        changed = true;
    }
    if obj.get("bNeedsValidation").and_then(|v| v.as_bool()) == Some(true) {
        obj.insert(
            "bNeedsValidation".to_string(),
            serde_json::Value::Bool(false),
        );
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// user.json uses its REAL key layout (snake_case!).
    /// A mistake like `rename = "accountId"` would silently produce an empty id.
    const SAMPLE_USER: &str = r#"{
        "account_id": "00000000000000000000000000000000",
        "displayName": "Efxlve",
        "app": "EpicGamesLauncher"
    }"#;

    #[test]
    fn parses_user_display_name_and_id() {
        let u: UserFile = serde_json::from_str(SAMPLE_USER).expect("parse edilmeli");
        assert_eq!(u.display_name, "Efxlve");
        assert_eq!(u.account_id, "00000000000000000000000000000000");
    }

    #[test]
    fn egl_tools_are_not_games() {
        // Unreal Engine, Fab and Quixel carry the `ue` namespace.
        let unreal = serde_json::json!({
            "AppName": "UnrealEngine",
            "DisplayName": "Unreal Engine",
            "CatalogNamespace": "ue"
        });
        assert!(!is_game_manifest(&unreal));
        let fab = serde_json::json!({
            "AppName": "SomeFabPlugin",
            "DisplayName": "Some Plugin",
            "CatalogNamespace": "UE"
        });
        assert!(!is_game_manifest(&fab));

        // Older manifests without a namespace fall back to the names.
        for (app, title) in [
            ("UnrealEngine", "Unreal Engine"),
            ("UE_5.4", "Unreal Engine 5.4"),
            ("FabUePlugin", "Fab UE Plugin"),
            ("QuixelBridge", "Quixel Bridge"),
        ] {
            let val = serde_json::json!({ "AppName": app, "DisplayName": title });
            assert!(!is_game_manifest(&val), "{title} must not count as a game");
        }

        let game = serde_json::json!({
            "AppName": "Ginger",
            "DisplayName": "Cyberpunk 2077",
            "CatalogNamespace": "cb2077"
        });
        assert!(is_game_manifest(&game));
    }

    /// The rebuilt launcher keeps its installs in a per-user transaction log;
    /// the last record for an installation wins and DLC/tools must not become
    /// library rows.
    #[test]
    fn egl_v2_log_reads_the_current_installation_records() {
        let root = std::env::temp_dir().join(format!("efxlve-eglv2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let game_dir = root.join("SomeGame");
        std::fs::create_dir_all(game_dir.join(".egstore")).unwrap();
        std::fs::write(game_dir.join("Game.exe"), b"").unwrap();
        std::fs::create_dir_all(root.join("cache")).unwrap();
        std::fs::write(
            root.join("cache").join("disk-size-cache.json"),
            r#"{"entries":[{"app_id":{"appName":"gameA"},"bytes":12345.0}]}"#,
        )
        .unwrap();

        let target = game_dir.to_string_lossy().to_string();
        let records = [
            serde_json::json!({"version": 1, "writtenAt": "2026-10-02T15:09:59Z"}),
            serde_json::json!({
                "installationId": "same",
                "dir": target,
                "namespace": "ns",
                "artifactId": "gameA",
                "version": "1.0",
                "launchExecutable": "Game.exe"
            }),
            serde_json::json!({
                "installationId": "same",
                "dir": target,
                "namespace": "ns",
                "artifactId": "gameA",
                "version": "2.0",
                "launchExecutable": "Game.exe"
            }),
            serde_json::json!({
                "installationId": "dlc",
                "dir": target,
                "namespace": "ns",
                "artifactId": "dlcA",
                "parentInstallationId": "same"
            }),
            serde_json::json!({
                "installationId": "tool",
                "dir": target,
                "namespace": "ue",
                "artifactId": "UE_5"
            }),
            serde_json::json!({
                "installationId": "gone",
                "dir": root.join("Gone").to_string_lossy().to_string(),
                "namespace": "ns",
                "artifactId": "goneGame",
                "launchExecutable": "Gone.exe"
            }),
        ];
        let log = records
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(root.join("installations.jsonl"), log).unwrap();

        let (games, tools) = read_egl_v2_installations(&root);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].game.app_name, "gameA");
        assert_eq!(games[0].game.version, "2.0");
        assert_eq!(games[0].game.title, "SomeGame");
        assert_eq!(games[0].game.install_size, 12345);
        assert_eq!(tools, vec!["UE_5".to_string()]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn egl_v2_log_falls_back_to_the_previous_copy() {
        let root = std::env::temp_dir().join(format!("efxlve-eglv2-prev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let game_dir = root.join("PrevGame");
        std::fs::create_dir_all(game_dir.join(".egstore")).unwrap();
        let log = format!(
            "{}\n{}",
            serde_json::json!({"version": 1}),
            serde_json::json!({
                "installationId": "prev",
                "dir": game_dir.to_string_lossy().to_string(),
                "namespace": "ns",
                "artifactId": "prevGame",
                "launchExecutable": ""
            })
        );
        std::fs::write(root.join("installations.jsonl.prev"), log).unwrap();

        let (games, _) = read_egl_v2_installations(&root);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].game.app_name, "prevGame");
        assert_eq!(games[0].game.executable, "");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A real display name wins over the v2 folder-name fallback, while the
    /// newest record still supplies the path and version.
    #[test]
    fn egl_candidates_keep_the_display_name_and_the_newest_build() {
        let base = EglDetectedGame {
            app_name: "Ginger".into(),
            title: "Cyberpunk2077".into(),
            install_path: r"C:\Games\Cyberpunk2077".into(),
            executable: "Cyberpunk2077.exe".into(),
            version: "1.0".into(),
            install_size: 0,
        };
        let at = |secs| Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs));
        let mut out = Vec::new();
        let mut seen = HashMap::new();
        merge_egl_candidate(
            &mut out,
            &mut seen,
            EglCandidate {
                game: EglDetectedGame {
                    version: "0.9".into(),
                    ..base.clone()
                },
                written: at(1),
                named: false,
            },
        );
        merge_egl_candidate(
            &mut out,
            &mut seen,
            EglCandidate {
                game: EglDetectedGame {
                    title: "Cyberpunk 2077".into(),
                    version: "2.0".into(),
                    install_size: 100,
                    ..base.clone()
                },
                written: at(2),
                named: true,
            },
        );
        assert_eq!(out[0].game.title, "Cyberpunk 2077");
        assert_eq!(out[0].game.version, "2.0");
        assert_eq!(out[0].game.install_size, 100);

        merge_egl_candidate(
            &mut out,
            &mut seen,
            EglCandidate {
                game: EglDetectedGame {
                    executable: "New.exe".into(),
                    version: "3.0".into(),
                    ..base
                },
                written: at(3),
                named: false,
            },
        );
        assert_eq!(out[0].game.title, "Cyberpunk 2077");
        assert_eq!(out[0].game.executable, "New.exe");
        assert_eq!(out[0].game.version, "3.0");
    }

    #[test]
    fn test_read_egl_installed_games_parses() {
        // The folder can be an empty leftover after the Epic Launcher is
        // uninstalled or its games were removed; the check only makes sense
        // when at least one manifest still points at a folder on disk.
        let dir = egl_manifests_dir();
        let installed_manifest = std::fs::read_dir(&dir)
            .map(|entries| {
                entries.flatten().any(|entry| {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("item") {
                        return false;
                    }
                    let Ok(text) = std::fs::read_to_string(&path) else {
                        return false;
                    };
                    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
                        return false;
                    };
                    let main = val
                        .get("MainGameAppName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let loc = val
                        .get("InstallLocation")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    main.is_empty() && !loc.is_empty() && Path::new(loc).is_dir()
                })
            })
            .unwrap_or(false);
        if !installed_manifest {
            return;
        }
        let games = read_egl_installed_games();
        assert!(
            !games.is_empty(),
            "If an installed EGL manifest exists there must be at least one game"
        );
        let has_cyberpunk_or_rdr = games
            .iter()
            .any(|g| g.app_name == "Ginger" || g.app_name == "Heather");
        assert!(has_cyberpunk_or_rdr, "Cyberpunk or RDR2 must be detected");
    }

    #[test]
    fn library_snapshot_round_trips() {
        let dir = std::env::temp_dir().join(format!("efxlve-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let games = vec![LegendaryGame {
            app_name: "snap-game".into(),
            app_title: "Snap Game".into(),
            ..Default::default()
        }];
        write_library_snapshot(&dir, &games);
        let back = read_library_snapshot(&dir).expect("snapshot should round-trip");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].app_name, "snap-game");
        std::fs::write(snapshot_path(&dir), "[]").unwrap();
        let empty = read_library_snapshot(&dir).expect("empty snapshot stays present");
        assert!(empty.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_installed_merges_all() {
        let config = crate::legendary::skip::default_config_dir();
        let installed = read_installed(&config);
        if egl_manifests_dir().is_dir() {
            assert!(
                installed.len() >= 6,
                "At least 6 installed games (EGL + Legendary) must be found"
            );
            let has_spider_or_wand = installed.iter().any(|g| {
                g.app_name.contains("be23672deb69402781cd47cc2919caf4")
                    || g.title.contains("Spider-Man")
                    || g.title == "Wand"
            });
            assert!(
                has_spider_or_wand,
                "Spider-Man or Wand must be in the installed list"
            );
        }
    }

    #[test]
    fn test_remove_game_from_installed_json() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_cache_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let json_path = dir.join("installed.json");
        let initial =
            r#"{"ReadyOrNot": {"app_name": "ReadyOrNot"}, "Cyberpunk": {"app_name": "Cyberpunk"}}"#;
        std::fs::write(&json_path, initial).unwrap();

        remove_game_from_installed_json(&dir, "ReadyOrNot");

        let text = std::fs::read_to_string(&json_path).unwrap();
        assert!(!text.contains("ReadyOrNot"));
        assert!(text.contains("Cyberpunk"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installed_install_tags_reads_only_the_record() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_tags_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("installed.json"),
            r#"{"Fortnite": {"app_name": "Fortnite", "install_tags": ["", "FortniteBR"]}}"#,
        )
        .unwrap();

        assert_eq!(
            installed_install_tags(&dir, "Fortnite"),
            vec!["".to_string(), "FortniteBR".to_string()]
        );
        assert!(installed_install_tags(&dir, "Missing").is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Python's `json.load` uses the system code page, so a literal "™" in a
    /// title made installed.json unreadable on a Turkish Windows and legendary
    /// reported every game as not installed. Keep the file ASCII-only.
    #[test]
    fn installed_json_stays_ascii_for_legendarys_python_reader() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_ascii_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let game_dir = dir.join("UNCHARTED");
        std::fs::create_dir_all(&game_dir).unwrap();

        let mut record = installed_record("1.0", game_dir.to_str().unwrap());
        record.title = "UNCHARTED™ – Legacy".to_string();
        let mut map = HashMap::new();
        map.insert("Fortnite".to_string(), record);
        write_installed_map(&dir, &map);

        let text = std::fs::read_to_string(dir.join("installed.json")).unwrap();
        assert!(text.is_ascii(), "legendary cannot decode non-ASCII bytes");
        assert!(text.contains("\\u2122"));
        let parsed: HashMap<String, InstalledGame> = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["Fortnite"].title, "UNCHARTED™ – Legacy");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A resumed download records only the bytes it still had to fetch. The
    /// manage panel must show the folder it describes, not that delta.
    #[test]
    fn a_resumed_install_size_is_remeasured_from_disk() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_size_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let game_dir = dir.join("Fortnite");
        std::fs::create_dir_all(game_dir.join("Paks")).unwrap();
        std::fs::write(game_dir.join("game.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(game_dir.join("Paks").join("pak.bin"), vec![0u8; 250]).unwrap();

        let mut map = HashMap::new();
        map.insert(
            "Fortnite".to_string(),
            installed_record("1.0", game_dir.to_str().unwrap()),
        );
        write_installed_map(&dir, &map);

        assert!(refresh_installed_size(&dir, "fortnite"));
        let text = std::fs::read_to_string(dir.join("installed.json")).unwrap();
        let map: HashMap<String, InstalledGame> = serde_json::from_str(&text).unwrap();
        assert_eq!(map["Fortnite"].install_size, 350);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A truncated installed.json used to hide every install ("library says
    /// Install"). The last good copy is one read away.
    #[test]
    fn a_truncated_installed_file_recovers_from_the_backup() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_recover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let game_dir = dir.join("Fortnite");
        std::fs::create_dir_all(&game_dir).unwrap();

        let mut map = HashMap::new();
        map.insert(
            "Fortnite".to_string(),
            installed_record("1.0", game_dir.to_str().unwrap()),
        );
        // First write creates the file, the second one also fills the backup.
        write_installed_map(&dir, &map);
        write_installed_map(&dir, &map);
        std::fs::write(dir.join("installed.json"), "{truncated").unwrap();

        let installed = read_installed(&dir);
        let game = installed
            .iter()
            .find(|game| game.app_name == "Fortnite")
            .expect("the backup record must survive a truncated main file");
        assert_eq!(game.version, "1.0");

        let repaired = std::fs::read_to_string(dir.join("installed.json")).unwrap();
        assert!(
            serde_json::from_str::<HashMap<String, InstalledGame>>(&repaired).is_ok(),
            "the recovered map must be written back"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_launchers_write_is_not_clobbered_by_a_stale_snapshot() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_stamp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let game_dir = dir.join("Fortnite");
        std::fs::create_dir_all(&game_dir).unwrap();

        let mut ours = HashMap::new();
        ours.insert(
            "Fortnite".to_string(),
            installed_record("1.0", game_dir.to_str().unwrap()),
        );
        write_installed_map(&dir, &ours);
        let stamp = installed_stamp(&dir);

        // Heroic or the CLI writes a new record after our read.
        let mut other = HashMap::new();
        let mut record = installed_record("2.0", game_dir.to_str().unwrap());
        record.app_name = "SomeOtherGame".to_string();
        record.title = "Some Other Game".to_string();
        other.insert("SomeOtherGame".to_string(), record);
        write_installed_map(&dir, &other);

        assert!(
            !write_installed_map_if_unchanged(&dir, stamp, &ours),
            "a stale snapshot must not overwrite another launcher's write"
        );
        let text = std::fs::read_to_string(dir.join("installed.json")).unwrap();
        assert!(text.contains("SomeOtherGame"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_installed_version_updates_item_fields() {
        let mut val = serde_json::json!({
            "AppName": "Ginger",
            "AppVersionString": "2.31_hotfix",
            "InstallSize": 66400731896u64,
            "bNeedsValidation": true
        });

        assert!(apply_installed_version(
            &mut val,
            "2.32_hotfix",
            117213238008
        ));
        assert_eq!(val["AppVersionString"], "2.32_hotfix");
        assert_eq!(val["InstallSize"], 117213238008u64);
        assert_eq!(val["bNeedsValidation"], false);

        // Re-running with the same values must be a no-op (no needless writes).
        assert!(!apply_installed_version(
            &mut val,
            "2.32_hotfix",
            117213238008
        ));

        // An unknown version must not clobber whatever EGL already stored.
        assert!(!apply_installed_version(&mut val, "", 117213238008));
        assert_eq!(val["AppVersionString"], "2.32_hotfix");
    }

    #[test]
    fn a_plain_version_stays_as_it_is() {
        assert_eq!(display_version("10.2.1.2"), "10.2.1.2");
        assert_eq!(display_version(" 1.0.1158.13 "), "1.0.1158.13");
        assert_eq!(display_version(""), "");
    }

    #[test]
    fn an_egl_platform_suffix_is_not_a_new_build() {
        // Fortnite's EGL `.item` appends the platform; the catalog build does not.
        assert_eq!(
            display_version("++Fortnite+Release-38.10-CL-46968237-Windows"),
            "++Fortnite+Release-38.10-CL-46968237"
        );
        assert_eq!(
            display_version("++Fortnite+Release-38.10-CL-46968237"),
            "++Fortnite+Release-38.10-CL-46968237"
        );
        assert_eq!(display_version("SomeGame-1.0-win64"), "SomeGame-1.0");
    }

    #[test]
    fn an_artifact_name_shows_only_its_version() {
        assert_eq!(
            display_version("DBD_Vanilla_HFL_EGS_Shipping_9_3871532_10.2.0.7"),
            "10.2.0.7"
        );
        assert_eq!(display_version("Some_Game_1.0"), "1.0");
        assert_eq!(display_version("Some_Game_2026"), "2026");
        // Nothing number-like to pull out: the value is shown unchanged.
        assert_eq!(display_version("BuildNightly"), "BuildNightly");
    }

    fn egl_game(version: &str, install_path: &str) -> EglDetectedGame {
        EglDetectedGame {
            app_name: "Fortnite".to_string(),
            title: "Fortnite".to_string(),
            install_path: install_path.to_string(),
            executable: "FortniteLauncher.exe".to_string(),
            version: version.to_string(),
            install_size: 0,
        }
    }

    fn installed_record(version: &str, install_path: &str) -> InstalledGame {
        serde_json::from_value(serde_json::json!({
            "app_name": "Fortnite",
            "title": "Fortnite",
            "version": version,
            "install_path": install_path,
            "install_size": 100,
        }))
        .expect("a minimal installed record must parse")
    }

    /// The reported bug: updating in the Epic Games Launcher left installed.json
    /// on the old build, so the launcher kept offering the same update and
    /// legendary later diffed from files that were no longer on disk.
    #[test]
    fn an_egl_update_replaces_the_stale_installed_version() {
        let mut map = HashMap::from([(
            "Fortnite".to_string(),
            installed_record("1.0", "C:\\Games\\Fortnite"),
        )]);
        let merge = merge_egl_record(&mut map, &egl_game("2.0", "C:\\Games\\Fortnite"));
        assert_eq!(merge, EglMerge::Updated);
        assert_eq!(map["Fortnite"].version, "2.0");
    }

    /// EGL's `.item` describes the manifest on disk. It stays the diff base even
    /// when the catalog still names another build; the catalog only decides
    /// whether an update is offered.
    #[test]
    fn a_live_egl_record_owns_the_diff_base() {
        let mut map = HashMap::from([(
            "Fortnite".to_string(),
            installed_record("2.0", "C:\\Games\\Fortnite"),
        )]);
        assert_eq!(
            merge_egl_record(&mut map, &egl_game("1.0", "C:\\Games\\Fortnite")),
            EglMerge::Updated
        );
        assert_eq!(map["Fortnite"].version, "1.0");
    }

    #[test]
    fn egl_versions_are_matched_case_insensitively_and_without_a_catalog() {
        let mut map = HashMap::from([(
            "Fortnite".to_string(),
            installed_record("1.0", "c:/games/fortnite/"),
        )]);
        assert_eq!(
            merge_egl_record(&mut map, &egl_game("2.0", "C:\\Games\\Fortnite")),
            EglMerge::Updated
        );
        // EGL writes artifact names for some games; the on-disk build wins.
        assert_eq!(
            merge_egl_record(
                &mut map,
                &egl_game("Some_Build_2.0", "C:\\Games\\Fortnite")
            ),
            EglMerge::Updated
        );
        assert_eq!(map["Fortnite"].version, "Some_Build_2.0");
    }

    #[test]
    fn a_second_install_folder_never_overwrites_the_tracked_record() {
        let mut map = HashMap::from([(
            "Fortnite".to_string(),
            installed_record("1.0", "C:\\Games\\Fortnite"),
        )]);
        assert_eq!(
            merge_egl_record(&mut map, &egl_game("2.0", "D:\\Other\\Fortnite")),
            EglMerge::Unchanged
        );
        assert_eq!(map["Fortnite"].install_path, "C:\\Games\\Fortnite");
    }

    #[test]
    fn an_untracked_egl_game_is_added_once() {
        let mut map = HashMap::new();
        let egl = egl_game("2.0", "C:\\Games\\Fortnite");
        assert_eq!(merge_egl_record(&mut map, &egl), EglMerge::Added);
        assert_eq!(merge_egl_record(&mut map, &egl), EglMerge::Unchanged);
        assert_eq!(map.len(), 1);
    }

    /// A third-party probe needs BOTH registry halves; anything else is skipped
    /// before a `reg query` process is ever started.
    #[test]
    fn third_party_probe_requires_both_registry_halves() {
        let both = serde_json::json!({
            "RegistryPath": { "value": "SOFTWARE\\Ubisoft\\Launcher\\Installs\\1234" },
            "RegistryKey": { "value": "InstallDir" }
        });
        // A path that does not exist on any machine must return None, not panic.
        assert_eq!(probe_install_location(&both), None);

        let path_only = serde_json::json!({ "RegistryPath": { "value": "SOFTWARE\\X" } });
        assert_eq!(probe_install_location(&path_only), None);
        let key_only = serde_json::json!({ "RegistryKey": { "value": "InstallDir" } });
        assert_eq!(probe_install_location(&key_only), None);
        assert_eq!(probe_install_location(&serde_json::json!({})), None);
    }

    /// The metadata walk is the fallback before a snapshot exists: it must find the
    /// `customAttributes` that decide third-party detection, and skip broken files.
    #[test]
    fn metadata_candidates_reads_registry_attributes_and_skips_broken_files() {
        let dir = std::env::temp_dir().join(format!("efxlve_cache_test_{}", std::process::id()));
        let meta = dir.join("metadata");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("game.json"),
            r#"{"app_name":"Ubisoft1","app_title":"A Ubisoft Game","metadata":{"customAttributes":{"RegistryPath":{"value":"SOFTWARE\\Ubisoft"},"RegistryKey":{"value":"InstallDir"}}}}"#,
        )
        .unwrap();
        std::fs::write(meta.join("broken.json"), "{not json").unwrap();
        std::fs::write(meta.join("ignored.txt"), "not metadata").unwrap();

        let found = metadata_candidates(&dir);
        assert_eq!(found.len(), 1, "only the readable catalog entry counts");
        let (app_name, title, attrs) = &found[0];
        assert_eq!(app_name, "Ubisoft1");
        assert_eq!(title, "A Ubisoft Game");
        assert!(attrs.as_ref().unwrap().get("RegistryPath").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
