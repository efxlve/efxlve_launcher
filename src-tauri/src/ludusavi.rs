//! Save-path lookup backed by the Ludusavi manifest.
//!
//! The upstream manifest is a 17 MB YAML file. Parsing it at every launch is
//! needless work on a low-end machine, so a build-time index carries only the
//! concrete `tags: [save]` paths and the Steam id map. It is compressed in the
//! binary and expanded once, on the first save lookup.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(serde::Deserialize)]
struct RawIndex {
    steam: HashMap<String, String>,
    saves: HashMap<String, Vec<String>>,
    normalized: HashMap<String, String>,
}

struct Index {
    steam: HashMap<String, String>,
    saves: HashMap<String, Vec<String>>,
    normalized: HashMap<String, String>,
}

static INDEX: OnceLock<Option<Index>> = OnceLock::new();

fn index() -> Option<&'static Index> {
    INDEX
        .get_or_init(|| {
            let bytes = include_bytes!("../assets/ludusavi-saves.json.gz");
            let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
            let mut text = String::new();
            decoder.read_to_string(&mut text).ok()?;
            let raw: RawIndex = serde_json::from_str(&text).ok()?;
            Some(Index {
                steam: raw.steam,
                saves: raw.saves,
                normalized: raw.normalized,
            })
        })
        .as_ref()
}

/// Same fold as the save finder: letters and digits only, lowercase.
pub fn normalize_title(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn manifest_title<'a>(index: &'a Index, app_name: &str, title: Option<&str>) -> Option<&'a str> {
    if let Some(id) = app_name.strip_prefix("steam::") {
        if let Some(found) = index.steam.get(id) {
            return Some(found.as_str());
        }
    }
    let candidates = [
        title.unwrap_or(""),
        app_name,
    ];
    for candidate in candidates {
        if candidate.trim().is_empty() {
            continue;
        }
        let key = normalize_title(candidate);
        if let Some(found) = index.normalized.get(&key) {
            return index.saves.get_key_value(found).map(|(name, _)| name.as_str());
        }
        // Edition suffixes ("Deluxe Edition", "GOTY") are not part of the
        // manifest title. Try the part before the first colon/dash as a last
        // resort, never the other way round.
        for separator in [":", " - ", " – "] {
            if let Some(head) = candidate.split(separator).next() {
                let key = normalize_title(head);
                if key.len() >= 4 {
                    if let Some(found) = index.normalized.get(&key) {
                        return index.saves.get_key_value(found).map(|(name, _)| name.as_str());
                    }
                }
            }
        }
    }
    None
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

fn home_path() -> Option<PathBuf> {
    env_path("USERPROFILE").or_else(|| env_path("HOME"))
}

/// Expands the documented Ludusavi placeholders. An unknown placeholder makes
/// the whole pattern unusable instead of writing a literal `<token>` folder.
fn expand_pattern(
    pattern: &str,
    title: &str,
    app_name: &str,
    install_path: Option<&Path>,
) -> Option<PathBuf> {
    let home = home_path()?;
    let install_name = install_path
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| title.to_string());
    let store_id = app_name
        .strip_prefix("steam::")
        .or_else(|| app_name.strip_prefix("gog::"))
        .or_else(|| app_name.strip_prefix("amazon::"))
        .unwrap_or("");
    let user_name = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();

    let mut out = pattern.to_string();
    let mut replace = |token: &str, value: Option<String>| -> bool {
        if !out.contains(token) {
            return true;
        }
        match value {
            Some(value) if !value.is_empty() => {
                out = out.replace(token, &value);
                true
            }
            _ => false,
        }
    };

    let home_text = home.to_string_lossy().to_string();
    if !replace("<home>", Some(home_text.clone())) {
        return None;
    }
    if !replace(
        "<winAppData>",
        env_path("APPDATA").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winLocalAppData>",
        env_path("LOCALAPPDATA").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winLocalAppDataLow>",
        Some(home.join("AppData").join("LocalLow").to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winDocuments>",
        Some(home.join("Documents").to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winPublic>",
        env_path("PUBLIC").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winProgramData>",
        env_path("PROGRAMDATA").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<winDir>",
        env_path("WINDIR").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if pattern.contains("<base>") || pattern.contains("<root>") || pattern.contains("<game>") {
        let Some(install) = install_path else {
            return None;
        };
        let install_text = install.to_string_lossy().to_string();
        if !replace("<base>", Some(install_text.clone())) {
            return None;
        }
        if !replace(
            "<root>",
            install
                .parent()
                .map(|path| path.to_string_lossy().to_string()),
        ) {
            return None;
        }
        if !replace("<game>", Some(install_name)) {
            return None;
        }
    }
    if !replace(
        "<xdgData>",
        env_path("XDG_DATA_HOME").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace(
        "<xdgConfig>",
        env_path("XDG_CONFIG_HOME").map(|path| path.to_string_lossy().to_string()),
    ) {
        return None;
    }
    if !replace("<storeGameId>", Some(store_id.to_string())) {
        return None;
    }
    if !replace("<storeUserId>", None) {
        return None;
    }
    if !replace("<osUserName>", Some(user_name)) {
        return None;
    }

    // Any leftover angle-bracket token is a schema feature this build does not
    // know; refusing beats creating a literal `<placeholder>` directory.
    if out.contains('<') && out.contains('>') {
        return None;
    }
    let path = PathBuf::from(out);
    path.is_absolute().then_some(path)
}

/// Returns the first existing save folder the manifest names for this game.
/// Concrete patterns only; wildcard paths are dropped when the index is built
/// because they can widen a backup to a whole user folder.
pub fn save_path(app_name: &str, title: Option<&str>, install_path: Option<&str>) -> Option<String> {
    let index = index()?;
    let name = manifest_title(index, app_name, title)?;
    let patterns = index.saves.get(name)?;
    let install = install_path.map(Path::new);
    let mut existing: Vec<PathBuf> = Vec::new();
    for pattern in patterns {
        let Some(path) = expand_pattern(pattern, name, app_name, install) else {
            continue;
        };
        if path.is_dir() {
            existing.push(path);
        } else if path.is_file() {
            if let Some(parent) = path.parent() {
                if parent.is_dir() {
                    existing.push(parent.to_path_buf());
                }
            }
        }
    }
    // Prefer the user's profile over a path inside the install folder: the
    // latter is often a launcher-created cache, not the real save tree.
    let home = home_path();
    existing.sort_by_key(|path| {
        let in_home = home
            .as_ref()
            .map(|home| path.starts_with(home))
            .unwrap_or(false);
        let in_install = install
            .map(|install| path.starts_with(install))
            .unwrap_or(false);
        (!in_home, in_install)
    });
    existing
        .into_iter()
        .next()
        .map(|path| {
            let text = path.to_string_lossy().to_string();
            // Manifest paths use forward slashes; Windows paths in the UI and
            // in every store record use backslashes.
            #[cfg(windows)]
            let text = text.replace('/', "\\");
            text
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_maps_a_steam_id_to_its_title() {
        let index = index().expect("the bundled index must load");
        assert_eq!(
            manifest_title(index, "steam::1091500", None),
            Some("Cyberpunk 2077")
        );
    }

    #[test]
    fn titles_fold_punctuation_and_case() {
        assert_eq!(normalize_title("Cyberpunk 2077"), "cyberpunk2077");
        let index = index().expect("index");
        assert_eq!(
            manifest_title(index, "Ginger", Some("Cyberpunk 2077")),
            Some("Cyberpunk 2077")
        );
    }

    #[test]
    fn placeholders_expand_to_real_roots() {
        let home = home_path().expect("home");
        let expanded = expand_pattern("<home>/Example/Save", "Example", "ginger", None)
            .expect("home expands");
        assert!(expanded.starts_with(&home));
        assert!(home.is_dir());
    }

    #[test]
    fn an_unknown_placeholder_is_rejected() {
        assert!(expand_pattern(
            "<storeUserId>/save",
            "Example",
            "steam::1",
            None
        )
        .is_none());
        assert!(expand_pattern("<notAThing>/save", "Example", "x", None).is_none());
    }

    #[test]
    fn cyberpunk_uses_the_saved_games_folder_when_it_exists() {
        let Some(home) = home_path() else {
            return;
        };
        let saved = home
            .join("Saved Games")
            .join("CD Projekt Red")
            .join("Cyberpunk 2077");
        if !saved.is_dir() {
            // CI has no game saves; the index lookup above still covers the map.
            return;
        }
        assert_eq!(
            save_path("steam::1091500", Some("Cyberpunk 2077"), None),
            Some(saved.to_string_lossy().to_string())
        );
    }
}
