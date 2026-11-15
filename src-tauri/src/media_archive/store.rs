//! Store metadata capture and registration after a restore.
//!
//! A restore that only drops files on disk still looks uninstalled to Steam,
//! Epic, GOG or Nile. This module carries the small records those clients read
//! and writes them back against the new folder.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use super::format::{MediaManifest, StoreMeta};
use crate::custom_games::{load_custom_games, save_custom_games, CustomGame};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRegistration {
    pub registered: bool,
    pub detail: String,
    pub warning: Option<String>,
}

impl RestoreRegistration {
    fn registered(detail: &str) -> Self {
        Self {
            registered: true,
            detail: detail.to_string(),
            warning: None,
        }
    }

    fn warning(detail: &str, warning: &str) -> Self {
        Self {
            registered: false,
            detail: detail.to_string(),
            warning: Some(warning.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub enum StorePending {
    Epic(String),
    Amazon(String),
}

pub struct LocalRegistration {
    pub registration: RestoreRegistration,
    pub pending: Option<StorePending>,
}

pub fn store_of(app_name: &str) -> &'static str {
    if app_name.starts_with("steam::") {
        "steam"
    } else if app_name.starts_with("gog::") {
        "gog"
    } else if app_name.starts_with("amazon::") {
        "amazon"
    } else if app_name.starts_with("custom::") {
        "custom"
    } else if app_name.starts_with("ubisoft::") {
        "ubisoft"
    } else if app_name.starts_with("ea::") {
        "ea"
    } else if app_name.starts_with("xbox::") {
        "xbox"
    } else if app_name.starts_with("battlenet::") {
        "battlenet"
    } else if app_name.starts_with("riot::") {
        "riot"
    } else {
        "epic"
    }
}

/// Small store records for the manifest. Missing records are fine; the restore
/// simply reports that the store needs a manual import.
pub fn capture(app: &AppHandle, app_name: &str, install_path: &Path) -> StoreMeta {
    let mut meta = StoreMeta::default();
    match store_of(app_name) {
        "steam" => {
            let id = app_name.trim_start_matches("steam::").to_string();
            meta.steam_app_id = Some(id.clone());
            if let Some(steam) = crate::steam::steam_install_path() {
                for game in crate::steam::installed_games(&steam) {
                    if game.app_id != id {
                        continue;
                    }
                    let acf = Path::new(&game.library)
                        .join(format!("appmanifest_{id}.acf"));
                    meta.steam_acf = std::fs::read_to_string(acf).ok();
                    break;
                }
            }
        }
        "gog" => {
            meta.gog_game_id = Some(app_name.trim_start_matches("gog::").to_string());
        }
        "amazon" => {
            meta.amazon_product_id =
                Some(app_name.trim_start_matches("amazon::").to_string());
        }
        "custom" => {
            let id = app_name.trim_start_matches("custom::");
            if let Some(game) = load_custom_games(app)
                .into_iter()
                .find(|game| game.id == app_name || game.id == id)
            {
                meta.custom_exe_rel = custom_relative_exe(&game.exe_path, install_path);
                meta.custom_game = serde_json::to_value(&game).ok();
            }
        }
        "epic" => {
            meta.epic_app_name = Some(app_name.to_string());
        }
        _ => {}
    }
    meta
}

fn custom_relative_exe(exe_path: &str, install_path: &Path) -> Option<String> {
    let path = Path::new(exe_path.trim());
    if let Ok(rel) = path.strip_prefix(install_path) {
        if !rel.as_os_str().is_empty() {
            return Some(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
}

pub fn register_local(
    app: &AppHandle,
    manifest: &MediaManifest,
    target: &Path,
) -> LocalRegistration {
    match manifest.store.as_str() {
        "steam" => {
            let detail = "@t:archive.steamRegistered";
            let Some(acf) = manifest.store_meta.steam_acf.as_deref() else {
                return LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        "@t:archive.steamAcfMissing",
                    ),
                    pending: None,
                };
            };
            let Some(steamapps) = steamapps_ancestor(target) else {
                return LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        "@t:archive.steamNotInLibrary",
                    ),
                    pending: None,
                };
            };
            if steam_library_registered(steamapps) == Some(false) {
                return LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        "@t:archive.steamLibraryMissing",
                    ),
                    pending: None,
                };
            }
            let app_id = manifest
                .store_meta
                .steam_app_id
                .clone()
                .unwrap_or_else(|| manifest.app_name.trim_start_matches("steam::").to_string());
            let size = directory_size(target);
            let text = patch_acf(
                acf,
                &manifest.install_dir_name,
                size,
                super::pack::now_seconds(),
            );
            let path = steamapps.join(format!("appmanifest_{app_id}.acf"));
            match std::fs::write(&path, text) {
                Ok(()) => LocalRegistration {
                    registration: RestoreRegistration::registered(detail),
                    pending: None,
                },
                Err(error) => LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        &format!("@t:archive.acfWrite\u{1f}{error}"),
                    ),
                    pending: None,
                },
            }
        }
        "gog" => {
            let Some(id) = manifest.store_meta.gog_game_id.as_deref() else {
                return LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        "@t:archive.gogInfoMissing",
                    ),
                    pending: None,
                };
            };
            let Some(info) = crate::gogdl::cache::scan_gog_info(target, id) else {
                return LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        "@t:archive.gogInfoMissing",
                    ),
                    pending: None,
                };
            };
            let mut map = crate::gogdl::cache::load_installed_games(app);
            map.insert(id.to_string(), info);
            match crate::gogdl::cache::save_installed_games(app, &map) {
                Ok(()) => LocalRegistration {
                    registration: RestoreRegistration::registered("@t:archive.gogRegistered"),
                    pending: None,
                },
                Err(error) => LocalRegistration {
                    registration: RestoreRegistration::warning(
                        "@t:archive.notRegistered",
                        &format!("@t:archive.gogWrite\u{1f}{error}"),
                    ),
                    pending: None,
                },
            }
        }
        "custom" => register_custom(app, manifest, target),
        "epic" => LocalRegistration {
            registration: RestoreRegistration {
                registered: false,
                detail: "@t:archive.epicPending".to_string(),
                warning: None,
            },
            pending: Some(StorePending::Epic(
                manifest
                    .store_meta
                    .epic_app_name
                    .clone()
                    .unwrap_or_else(|| manifest.app_name.clone()),
            )),
        },
        "amazon" => {
            let id = manifest
                .store_meta
                .amazon_product_id
                .clone()
                .unwrap_or_else(|| manifest.app_name.trim_start_matches("amazon::").to_string());
            LocalRegistration {
                registration: RestoreRegistration {
                    registered: false,
                    detail: "@t:archive.amazonPending".to_string(),
                    warning: None,
                },
                pending: Some(StorePending::Amazon(id)),
            }
        }
        _ => LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.manualImportHint",
            ),
            pending: None,
        },
    }
}

fn register_custom(
    app: &AppHandle,
    manifest: &MediaManifest,
    target: &Path,
) -> LocalRegistration {
    let Some(value) = manifest.store_meta.custom_game.as_ref() else {
        return LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.customMissing",
            ),
            pending: None,
        };
    };
    let Ok(mut game) = serde_json::from_value::<CustomGame>(value.clone()) else {
        return LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.customMissing",
            ),
            pending: None,
        };
    };
    let rel = manifest
        .store_meta
        .custom_exe_rel
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(rel) = rel else {
        return LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.customExeMissing",
            ),
            pending: None,
        };
    };
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.customExeMissing",
            ),
            pending: None,
        };
    }
    let exe = target.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !exe.is_file() {
        return LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                "@t:archive.customExeMissing",
            ),
            pending: None,
        };
    }
    game.exe_path = exe.to_string_lossy().to_string();
    let mut games = load_custom_games(app);
    if let Some(existing) = games
        .iter_mut()
        .find(|entry| entry.id == game.id || entry.id == manifest.app_name)
    {
        *existing = game;
    } else {
        games.push(game);
    }
    match save_custom_games(app, &games) {
        Ok(()) => LocalRegistration {
            registration: RestoreRegistration::registered("@t:archive.customRegistered"),
            pending: None,
        },
        Err(error) => LocalRegistration {
            registration: RestoreRegistration::warning(
                "@t:archive.notRegistered",
                &format!("@t:archive.customWrite\u{1f}{error}"),
            ),
            pending: None,
        },
    }
}

pub async fn finish_pending(
    app: &AppHandle,
    pending: StorePending,
    target: &Path,
) -> RestoreRegistration {
    match pending {
        StorePending::Epic(app_name) => {
            match crate::legendary::import_installed::import_game(app, &app_name, target).await
            {
                Ok(()) => RestoreRegistration::registered("@t:archive.epicRegistered"),
                Err(error) => RestoreRegistration::warning(
                    "@t:archive.notRegistered",
                    &format!("@t:archive.epicImportFailed\u{1f}{error}"),
                ),
            }
        }
        StorePending::Amazon(id) => {
            match crate::nile::manage::nile_import(
                app.clone(),
                id,
                target.to_string_lossy().to_string(),
            )
            .await
            {
                Ok(()) => RestoreRegistration::registered("@t:archive.amazonRegistered"),
                Err(error) => RestoreRegistration::warning(
                    "@t:archive.notRegistered",
                    &format!("@t:archive.amazonImportFailed\u{1f}{error}"),
                ),
            }
        }
    }
}

/// `None` when Steam is not installed, so an unverifiable target is not
/// treated as wrong. The main library and every `libraryfolders.vdf` entry are
/// accepted.
fn steam_library_registered(steamapps: &Path) -> Option<bool> {
    let steam = crate::steam::steam_install_path()?;
    let wanted = path_key(steamapps);
    Some(
        crate::steam::library_folders(&steam)
            .iter()
            .any(|folder| path_key(folder) == wanted),
    )
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn steamapps_ancestor(path: &Path) -> Option<&Path> {
    for ancestor in path.ancestors() {
        if ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        {
            return Some(ancestor);
        }
    }
    None
}

fn directory_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if super::pack::is_link(&meta.file_type()) {
            continue;
        }
        if meta.is_dir() {
            total = total.saturating_add(directory_size(&entry.path()));
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Rewrites the fields Steam reads while deciding whether a game is installed.
/// Everything else in the original manifest (depots, shared depots, build id)
/// is kept exactly as Steam wrote it.
fn patch_acf(
    text: &str,
    install_dir_name: &str,
    size_on_disk: u64,
    now: u64,
) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    set_fields(
        &mut lines,
        &[
            ("installdir", install_dir_name.to_string()),
            ("StateFlags", "4".to_string()),
            ("BytesToDownload", "0".to_string()),
            ("BytesDownloaded", "0".to_string()),
            ("BytesToStage", "0".to_string()),
            ("BytesStaged", "0".to_string()),
            ("BytesToVerify", "0".to_string()),
            ("UpdateResult", "0".to_string()),
            ("SizeOnDisk", size_on_disk.to_string()),
            ("LastUpdated", now.to_string()),
        ],
    );
    let mut output = lines.join("\n");
    output.push('\n');
    output
}

fn set_fields(lines: &mut Vec<String>, fields: &[(&str, String)]) {
    for (key, value) in fields {
        let needle = format!("\"{key}\"");
        let found = lines.iter().position(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with(&needle)
        });
        match found {
            Some(index) => {
                lines[index] = format!("\t\"{key}\"\t\t\"{value}\"");
            }
            None => {
                let insert = lines
                    .iter()
                    .rposition(|line| line.trim() == "}")
                    .unwrap_or(lines.len());
                lines.insert(insert, format!("\t\"{key}\"\t\t\"{value}\""));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acf_patch_marks_the_app_installed_and_keeps_depots() {
        let source = r#""AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"StateFlags"		"1026"
	"BytesToDownload"		"999"
	"buildid"		"123"
	"InstalledDepots"
	{
		"1"		{ "manifest" "x" }
	}
}
"#;
        let patched = patch_acf(source, "Portal 2", 12345, 777);
        assert!(patched.contains("\"installdir\"\t\t\"Portal 2\""));
        assert!(patched.contains("\"StateFlags\"\t\t\"4\""));
        assert!(patched.contains("\"BytesToDownload\"\t\t\"0\""));
        assert!(patched.contains("\"SizeOnDisk\"\t\t\"12345\""));
        assert!(patched.contains("\"buildid\"\t\t\"123\""));
        assert!(patched.contains("\"InstalledDepots\""));
        assert!(patched.ends_with('\n'));
    }

    #[test]
    fn store_prefixes_are_recognized() {
        assert_eq!(store_of("steam::620"), "steam");
        assert_eq!(store_of("gog::1"), "gog");
        assert_eq!(store_of("amazon::x"), "amazon");
        assert_eq!(store_of("custom::x"), "custom");
        assert_eq!(store_of("Sugar"), "epic");
    }

    #[test]
    fn a_steamapps_ancestor_is_found() {
        let path = Path::new(r"D:\SteamLibrary\steamapps\common\Portal 2");
        assert_eq!(
            steamapps_ancestor(path),
            Some(Path::new(r"D:\SteamLibrary\steamapps"))
        );
        assert!(steamapps_ancestor(Path::new(r"C:\Games\Portal 2")).is_none());
    }
}
