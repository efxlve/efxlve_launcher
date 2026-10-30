//! Games the launcher installed from Ubisoft's CDN without the client.
//!
//! The official client learns about an install from its own cache; this file is
//! the launcher's equivalent. It keeps the product id, the folder and the
//! executable a direct launch needs. Nothing here is a credential.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::accounts;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledGame {
    pub product_id: u32,
    pub name: String,
    pub install_dir: String,
    /// Path relative to `install_dir`, backslash form as the manifest wrote it.
    pub exe: String,
    pub installed_at: u64,
    /// The game's own install-path registry value from its product config, e.g.
    /// `HKEY_LOCAL_MACHINE\SOFTWARE\Ubisoft\Beyond Good & Evil\Install path`.
    #[serde(default)]
    pub install_reg: String,
}

fn path() -> PathBuf {
    if let Some(path) = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE") {
        return PathBuf::from(path);
    }
    accounts::data_dir().join("ubi_direct_installs.json")
}

pub(crate) fn load() -> Vec<InstalledGame> {
    let Ok(text) = std::fs::read_to_string(path()) else {
        return Vec::new();
    };
    let mut games: Vec<InstalledGame> = serde_json::from_str(&text).unwrap_or_default();
    games.retain(|game| game.product_id != 0 && !game.install_dir.is_empty());
    games
}

pub(crate) fn find(product_id: u32) -> Option<InstalledGame> {
    load().into_iter().find(|game| game.product_id == product_id)
}

pub(crate) fn save(game: &InstalledGame) {
    let mut games = load();
    games.retain(|existing| existing.product_id != game.product_id);
    games.push(game.clone());
    games.sort_by_key(|existing| existing.product_id);
    if let Some(parent) = path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&games) {
        let _ = std::fs::write(path(), text);
    }
}

pub(crate) fn remove(product_id: u32) {
    let mut games = load();
    games.retain(|game| game.product_id != product_id);
    if let Ok(text) = serde_json::to_string_pretty(&games) {
        let _ = std::fs::write(path(), text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_and_replace_by_product_id() {
        // Keep the real user file out of the test: point the record file at a
        // temporary path for the duration of this test.
        let temp = std::env::temp_dir().join(format!("efxlve-ubi-installs-{}.json", std::process::id()));
        let previous = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE");
        std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", &temp);
        let first = InstalledGame {
            product_id: 7,
            name: "Game".into(),
            install_dir: r"C:\Games\Game".into(),
            exe: r"bin\game.exe".into(),
            installed_at: 1,
            install_reg: String::new(),
        };
        save(&first);
        save(&InstalledGame {
            installed_at: 2,
            ..first.clone()
        });
        let loaded = load();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].installed_at, 2);
        remove(7);
        assert!(find(7).is_none());
        match previous {
            Some(value) => std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", value),
            None => std::env::remove_var("EFXLVE_UBI_INSTALLS_FILE"),
        }
        let _ = std::fs::remove_file(temp);
    }
}
