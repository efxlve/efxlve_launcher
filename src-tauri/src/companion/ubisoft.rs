//! Ubisoft Connect's local configuration cache and the imported owned catalog.
//!
//! The cache is a protobuf list of YAML documents. Each playable game has
//! `start_game` and a display name. Steam and Epic copies are left to those
//! stores. The file is a game list: account passwords are not in it, and this
//! parser never reads `settings.yaml`.
//!
//! Games the account owns but the client has not cached come from the sign-in
//! import and live in `companion_ubi_owned.json`.

use serde::{Deserialize, Serialize};

use super::proto::for_each_field;
use super::scan::slug;
use super::FoundGame;

struct UbiRow {
    install_id: u64,
    launch_id: u64,
    name: String,
}

pub(crate) fn games_from_configurations(bytes: &[u8], installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows(bytes) {
        let id = row.launch_id.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut game = FoundGame {
            store: "ubisoft".into(),
            id,
            name: row.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: format!("uplay://launch/{}/0", row.launch_id),
            install_uri: if row.install_id > 0 {
                format!("uplay://install/{}", row.install_id)
            } else {
                String::new()
            },
            uninstall_uri: format!("uplay://uninstall/{}", row.launch_id),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        };
        if let Some(hit) = installed.iter().find(|g| g.store == "ubisoft" && slug(&g.name) == slug(&row.name)) {
            game.installed = true;
            game.install_path = hit.install_path.clone();
        }
        games.push(game);
    }
    for extra in installed.iter().filter(|g| g.store == "ubisoft") {
        if games.iter().any(|g| slug(&g.name) == slug(&extra.name)) {
            continue;
        }
        games.push(extra.clone());
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn rows(bytes: &[u8]) -> Vec<UbiRow> {
    let mut rows = Vec::new();
    for_each_field(
        bytes,
        |field, payload| {
            if field != 1 {
                return;
            }
            if let Some(row) = row_from_record(payload) {
                rows.push(row);
            }
        },
        |_, _| {},
    );
    rows
}

fn row_from_record(record: &[u8]) -> Option<UbiRow> {
    let mut install_id = 0u64;
    let mut launch_id = 0u64;
    let mut yaml = String::new();
    for_each_field(
        record,
        |field, payload| {
            if field == 3 {
                yaml = String::from_utf8_lossy(payload).to_string();
            }
        },
        |field, value| {
            if field == 1 {
                install_id = value;
            } else if field == 2 {
                launch_id = value;
            }
        },
    );
    let launch_id = if launch_id == 0 { install_id } else { launch_id };
    if launch_id == 0 || !yaml.contains("start_game") {
        return None;
    }
    if is_other_store(&yaml) {
        return None;
    }
    let name = game_name(&yaml)?;
    Some(UbiRow { install_id, launch_id, name })
}

fn is_other_store(yaml: &str) -> bool {
    let Some(name) = child_value(yaml, "third_party_platform", "name") else {
        return false;
    };
    let name = name.to_lowercase();
    name == "steam" || name == "epic"
}

fn game_name(yaml: &str) -> Option<String> {
    let direct = child_value(yaml, "root", "name").unwrap_or_default();
    if usable(&direct) {
        return Some(direct);
    }
    for line in yaml.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed.strip_prefix("GAMENAME:") else {
            continue;
        };
        let name = clean_value(value);
        if usable(&name) {
            return Some(name);
        }
    }
    None
}

fn usable(name: &str) -> bool {
    let low = name.to_lowercase();
    !name.is_empty() && low != "gamename" && low != "l1" && low != "name" && low != "game_identifier"
}

/// Direct child `key:` under the first `block:` line.
fn child_value(yaml: &str, block: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = yaml.lines().collect();
    let header = format!("{block}:");
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == header {
            start = Some(i);
            break;
        }
    }
    let start = start?;
    let root_indent = indent_of(lines[start]);
    let mut child_indent = None;
    let prefix = format!("{key}:");
    for line in lines.iter().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let indent = indent_of(line);
        if indent <= root_indent {
            break;
        }
        if child_indent.is_none() {
            child_indent = Some(indent);
        }
        if Some(indent) == child_indent && line.trim().starts_with(&prefix) {
            return Some(clean_value(line.trim().trim_start_matches(&prefix)));
        }
    }
    None
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

fn clean_value(value: &str) -> String {
    let value = value.trim();
    let value = value.split(" #").next().unwrap_or(value).trim();
    value.trim_matches(|c| c == '"' || c == '\'').trim().to_string()
}

pub(crate) fn configurations_path() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).map(|p| {
        p.join("Ubisoft Game Launcher")
            .join("cache")
            .join("configuration")
            .join("configurations")
    });
    if let Some(path) = local {
        if path.is_file() {
            return Some(path);
        }
    }
    let program = std::path::PathBuf::from(
        r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\cache\configuration\configurations",
    );
    if program.is_file() { Some(program) } else { None }
}

fn owned_cache_path() -> std::path::PathBuf {
    super::accounts::data_dir().join("companion_ubi_owned.json")
}

/// One imported owned game. `id` is the Ubisoft space id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OwnedGame {
    pub id: String,
    pub name: String,
    /// Catalog box art; empty when the catalog had none for this game.
    #[serde(default)]
    pub cover: String,
    /// Catalog wide art; empty when the catalog had none for this game.
    #[serde(default)]
    pub hero: String,
    /// Catalog description; empty when the catalog had none for this game.
    #[serde(default)]
    pub description: String,
}

/// Writes the owned catalog captured at sign-in; ids are Ubisoft space ids.
pub(crate) fn save_owned(games: &[OwnedGame]) {
    let path = owned_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(games) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn load_owned() -> Vec<OwnedGame> {
    let Ok(text) = std::fs::read_to_string(owned_cache_path()) else {
        return Vec::new();
    };
    let rows: Vec<OwnedGame> = serde_json::from_str(&text).unwrap_or_default();
    rows.into_iter()
        .filter(|game| !game.id.is_empty() && !game.name.is_empty())
        .collect()
}

/// Local games plus the imported catalog the client has not cached yet.
pub(crate) fn merged_games(installed: &[FoundGame]) -> Vec<FoundGame> {
    let games = match configurations_path().and_then(|path| std::fs::read(path).ok()) {
        Some(bytes) => games_from_configurations(&bytes, installed),
        None => installed.iter().filter(|g| g.store == "ubisoft").cloned().collect(),
    };
    let mut games = merge_owned(games, &load_owned());
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Adds imported games whose name is not in the local list yet and copies the
/// catalog art and description onto the local row that matches by name. An
/// imported row has no launch id, so `companion_launch` hands it to the client.
pub(crate) fn merge_owned(mut games: Vec<FoundGame>, owned: &[OwnedGame]) -> Vec<FoundGame> {
    for game in owned {
        if let Some(local) = games.iter_mut().find(|g| slug(&g.name) == slug(&game.name)) {
            if local.cover_url.is_empty() {
                local.cover_url = game.cover.clone();
            }
            if local.hero_url.is_empty() {
                local.hero_url = game.hero.clone();
            }
            if local.description.is_empty() {
                local.description = game.description.clone();
            }
            continue;
        }
        games.push(FoundGame {
            store: "ubisoft".into(),
            id: game.id.clone(),
            name: game.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: game.cover.clone(),
            hero_url: game.hero.clone(),
            description: game.description.clone(),
        });
    }
    games
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};

    fn record(install: u64, launch: u64, yaml: &str) -> Vec<u8> {
        let mut body = Vec::new();
        push_varint_field(&mut body, 1, install);
        push_varint_field(&mut body, 2, launch);
        push_bytes(&mut body, 3, yaml.as_bytes());
        let mut msg = Vec::new();
        push_bytes(&mut msg, 1, &body);
        msg
    }

    #[test]
    fn yaml_name_prefers_the_real_title_over_the_placeholder() {
        let yaml = "root:\n  name: GAMENAME\n  start_game:\n    online: {}\nlocalizations:\n  default:\n    GAMENAME: Assassin's Creed\n";
        assert_eq!(game_name(yaml).as_deref(), Some("Assassin's Creed"));
        assert!(!is_other_store(yaml));
    }

    #[test]
    fn steam_copies_are_not_ubisoft_games() {
        let yaml = "root:\n  name: Ghost Recon\n  third_party_platform:\n    name: Steam\n  start_game:\n    steam: {}\n";
        assert!(is_other_store(yaml));
    }

    #[test]
    fn configuration_records_keep_launch_ids_and_skip_other_stores() {
        let owned = "root:\n  name: Watch Dogs\n  start_game:\n    online: {}\n";
        let steam = "root:\n  name: Far Cry\n  third_party_platform:\n    name: Steam\n  start_game:\n    steam: {}\n";
        let dlc = "root:\n  name: Season Pass\n";
        let mut bytes = record(12, 34, owned);
        bytes.extend(record(1, 2, steam));
        bytes.extend(record(3, 4, dlc));
        let games = games_from_configurations(&bytes, &[]);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].name, "Watch Dogs");
        assert_eq!(games[0].id, "34");
        assert_eq!(games[0].launch_uri, "uplay://launch/34/0");
        assert_eq!(games[0].install_uri, "uplay://install/12");
        assert_eq!(games[0].uninstall_uri, "uplay://uninstall/34");
        assert!(!games[0].installed);
    }

    #[test]
    fn imported_games_join_the_local_list_without_duplicating_names() {
        let local = vec![FoundGame {
            store: "ubisoft".into(),
            id: "34".into(),
            name: "Watch Dogs".into(),
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: "uplay://launch/34/0".into(),
            install_uri: "uplay://install/12".into(),
            uninstall_uri: "uplay://uninstall/34".into(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        }];
        let merged = merge_owned(
            local,
            &[
                OwnedGame { id: "space-1".into(), name: "Watch Dogs".into(), cover: "ubi-cover".into(), hero: String::new(), description: "Chicago hacker story".into() },
                OwnedGame { id: "space-2".into(), name: "Far Cry 6".into(), cover: "fc6-cover".into(), hero: "fc6-hero".into(), description: String::new() },
            ],
        );
        assert_eq!(merged.len(), 2);
        // The catalog art and description land on the local row that matches by name.
        assert_eq!(merged.iter().find(|g| g.id == "34").unwrap().cover_url, "ubi-cover");
        assert_eq!(merged.iter().find(|g| g.id == "34").unwrap().description, "Chicago hacker story");
        let imported = merged.iter().find(|g| g.id == "space-2").unwrap();
        assert_eq!(imported.name, "Far Cry 6");
        assert_eq!(imported.cover_url, "fc6-cover");
        assert_eq!(imported.hero_url, "fc6-hero");
        assert!(imported.description.is_empty());
        assert!(!imported.installed);
        assert!(imported.launch_uri.is_empty());
        assert_eq!(merged.iter().filter(|g| g.id == "34").count(), 1);
    }
}
