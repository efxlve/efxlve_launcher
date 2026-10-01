//! Battle.net's `product.db`.
//!
//! The file is a protobuf catalog of product codes and install paths. A
//! decryption key field exists in the same message; this parser never copies
//! it out.

use std::path::Path;

use super::proto::for_each_field;
use super::scan::slug;
use super::FoundGame;

const SKIP: &[&str] = &["agent", "bna", "battle.net", "agenthelper"];

pub(crate) fn games_from_db(bytes: &[u8], installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for_each_field(
        bytes,
        |field, payload| {
            if field != 1 {
                return;
            }
            let Some((code, path, is_installed)) = product(payload) else {
                return;
            };
            if !seen.insert(code.clone()) {
                return;
            }
            let Some(name) = display_name(&code, &path) else {
                return;
            };
            let id = slug(&code);
            if id.is_empty() {
                return;
            }
            let on_disk = !path.is_empty() && Path::new(&path).is_dir();
            games.push(FoundGame {
                store: "battlenet".into(),
                id,
                name,
                install_path: path,
                installed: is_installed || on_disk,
                store_id: String::new(),
                launch_exe: String::new(),
                launch_uri: format!("battlenet://{code}"),
            });
        },
        |_, _| {},
    );
    for game in &mut games {
        if let Some(hit) = installed.iter().find(|g| g.store == "battlenet" && (g.id == game.id || slug(&g.name) == slug(&game.name))) {
            game.installed = true;
            if game.install_path.is_empty() {
                game.install_path = hit.install_path.clone();
            }
        } else if !game.install_path.is_empty() && Path::new(&game.install_path).is_dir() {
            game.installed = true;
        }
    }
    for extra in installed.iter().filter(|g| g.store == "battlenet") {
        if games.iter().any(|g| g.id == extra.id || slug(&g.name) == slug(&extra.name)) {
            continue;
        }
        games.push(extra.clone());
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn product(msg: &[u8]) -> Option<(String, String, bool)> {
    let mut code = String::new();
    let mut path = String::new();
    let mut installed = false;
    for_each_field(
        msg,
        |field, payload| {
            if field == 2 {
                code = String::from_utf8_lossy(payload).trim().to_string();
            } else if field == 3 {
                for_each_field(
                    payload,
                    |inner, bytes| {
                        if inner == 1 {
                            path = String::from_utf8_lossy(bytes).trim().to_string();
                        }
                    },
                    |_, _| {},
                );
            } else if field == 4 {
                for_each_field(
                    payload,
                    |inner, bytes| {
                        if inner == 1 {
                            for_each_field(
                                bytes,
                                |_, _| {},
                                |base_field, value| {
                                    if base_field == 1 {
                                        installed = value != 0;
                                    }
                                },
                            );
                        }
                    },
                    |_, _| {},
                );
            }
        },
        |_, _| {},
    );
    let code_l = code.to_lowercase();
    if code.is_empty() || SKIP.iter().any(|s| *s == code_l) {
        return None;
    }
    Some((code, path, installed))
}

fn display_name(code: &str, path: &str) -> Option<String> {
    if let Some(name) = known_name(code) {
        return Some(name.to_string());
    }
    let folder = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !folder.is_empty() && !folder.eq_ignore_ascii_case(code) {
        return Some(folder);
    }
    None
}

fn known_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "s1" => "StarCraft",
        "s2" => "StarCraft II",
        "wow" => "World of Warcraft",
        "wow_classic" => "World of Warcraft Classic",
        "wow_classic_era" => "World of Warcraft Classic Era",
        "pro" | "prometheus" | "ow" => "Overwatch",
        "d3" | "diablo3" => "Diablo III",
        "fenris" => "Diablo IV",
        "osi" => "Diablo II: Resurrected",
        "w3" => "Warcraft III",
        "hsb" | "hs_beta" | "wtcg" => "Hearthstone",
        "hero" | "heroes" => "Heroes of the Storm",
        "viper" => "Call of Duty: Black Ops 4",
        "odin" => "Call of Duty: Modern Warfare",
        "lazarus" | "lazr" => "Call of Duty: MW2 Campaign Remastered",
        "zeus" => "Call of Duty: Black Ops Cold War",
        "fore" => "Call of Duty: Vanguard",
        "auks" => "Call of Duty: Modern Warfare II",
        "rtro" => "Blizzard Arcade Collection",
        "wlby" => "Crash Bandicoot 4: It's About Time",
        _ => return None,
    })
}

pub(crate) fn db_path() -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(r"C:\ProgramData\Battle.net\Agent\product.db");
    if path.is_file() { Some(path) } else { None }
}

fn owned_cache_path() -> std::path::PathBuf {
    super::accounts::data_dir().join("companion_bnet_owned.json")
}

/// Title ids from the Galaxy Blizzard plugin, plus Diablo IV.
fn title_game(title_id: u64) -> Option<(&'static str, &'static str)> {
    Some(match title_id {
        21297 => ("s1", "StarCraft"),
        21298 => ("s2", "StarCraft II"),
        5730135 => ("wow", "World of Warcraft"),
        5272175 => ("prometheus", "Overwatch"),
        22323 => ("w3", "Warcraft III"),
        1465140039 => ("hs_beta", "Hearthstone"),
        1214607983 => ("heroes", "Heroes of the Storm"),
        17459 => ("diablo3", "Diablo III"),
        4613486 => ("fenris", "Diablo IV"),
        1447645266 => ("viper", "Call of Duty: Black Ops 4"),
        1329875278 => ("odin", "Call of Duty: Modern Warfare"),
        1279351378 => ("lazarus", "Call of Duty: MW2 Campaign Remastered"),
        1514493267 => ("zeus", "Call of Duty: Black Ops Cold War"),
        1381257807 => ("rtro", "Blizzard Arcade Collection"),
        1464615513 => ("wlby", "Crash Bandicoot 4: It's About Time"),
        5198665 => ("osi", "Diablo II: Resurrected"),
        1179603525 => ("fore", "Call of Duty: Vanguard"),
        1146311730 => ("destiny2", "Destiny 2"),
        _ => return None,
    })
}

fn classic_game(name: &str) -> Option<(&'static str, &'static str)> {
    let folded = name.replace('\u{a0}', " ").to_lowercase();
    if folded.contains("lord of destruction") {
        return Some(("d2lod", "Diablo II: Lord of Destruction"));
    }
    if folded.contains("diablo") && folded.contains("ii") {
        return Some(("d2", "Diablo II"));
    }
    if folded.contains("frozen throne") {
        return Some(("w3tft", "Warcraft III: The Frozen Throne"));
    }
    if folded.contains("reign of chaos") || folded.contains("warcraft iii") {
        return Some(("w3roc", "Warcraft III: Reign of Chaos"));
    }
    if folded.contains("starcraft") && folded.contains("anthology") {
        return Some(("sca", "StarCraft Anthology"));
    }
    None
}

/// Owned games reported by Battle.net's account page (`games-and-subs` and classic games).
pub(crate) fn account_games(text: &str) -> Vec<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::Value::Null);
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    walk_account(&value, &mut games, &mut seen);
    if seen.contains("wow") && seen.insert("wow_classic".to_string()) {
        games.push(("wow_classic".into(), "World of Warcraft Classic".into()));
    }
    games
}

fn walk_account(value: &serde_json::Value, games: &mut Vec<(String, String)>, seen: &mut std::collections::HashSet<String>) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                walk_account(item, games, seen);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(title_id) = json_u64(map.get("titleId")) {
                if let Some((uid, name)) = title_game(title_id) {
                    if seen.insert(uid.to_string()) {
                        games.push((uid.to_string(), name.to_string()));
                    }
                }
            }
            if let Some(label) = map.get("localizedGameName").and_then(|v| v.as_str()) {
                if let Some((uid, name)) = classic_game(label) {
                    if seen.insert(uid.to_string()) {
                        games.push((uid.to_string(), name.to_string()));
                    }
                }
            }
            for child in map.values() {
                walk_account(child, games, seen);
            }
        }
        _ => {}
    }
}

fn json_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

pub(crate) fn save_owned(games: &[(String, String)]) {
    let path = owned_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let rows: Vec<serde_json::Value> = games
        .iter()
        .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
        .collect();
    if let Ok(text) = serde_json::to_string(&rows) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn load_owned() -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(owned_cache_path()) else {
        return Vec::new();
    };
    let rows: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    rows.into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let name = row.get("name")?.as_str()?.to_string();
            if id.is_empty() || name.is_empty() { None } else { Some((id, name)) }
        })
        .collect()
}

pub(crate) fn merged_games(installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games = match db_path().and_then(|path| std::fs::read(path).ok()) {
        Some(bytes) => games_from_db(&bytes, installed),
        None => installed.iter().filter(|g| g.store == "battlenet").cloned().collect(),
    };
    for (id, name) in load_owned() {
        if games.iter().any(|g| g.id == id) {
            continue;
        }
        games.push(FoundGame {
            store: "battlenet".into(),
            id: id.clone(),
            name,
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: format!("battlenet://{id}"),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};

    fn sample() -> Vec<u8> {
        let mut base = Vec::new();
        push_varint_field(&mut base, 1, 1);
        push_bytes(&mut base, 10, b"do-not-keep");
        let mut cached = Vec::new();
        push_bytes(&mut cached, 1, &base);
        let mut settings = Vec::new();
        push_bytes(&mut settings, 1, br"C:\Games\Diablo IV");
        let mut install = Vec::new();
        push_bytes(&mut install, 1, b"uid");
        push_bytes(&mut install, 2, b"fenris");
        push_bytes(&mut install, 3, &settings);
        push_bytes(&mut install, 4, &cached);
        let mut agent = Vec::new();
        push_bytes(&mut agent, 2, b"agent");
        let mut db = Vec::new();
        push_bytes(&mut db, 1, &install);
        push_bytes(&mut db, 1, &agent);
        db
    }

    #[test]
    fn product_db_names_the_game_and_drops_the_agent_and_the_key() {
        let games = games_from_db(&sample(), &[]);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].name, "Diablo IV");
        assert_eq!(games[0].id, "fenris");
        assert!(games[0].installed);
        assert_eq!(games[0].launch_uri, "battlenet://fenris");
        let dumped = format!("{games:?}");
        assert!(!dumped.contains("do-not-keep"));
    }

    #[test]
    fn account_page_lists_owned_titles_and_skips_unknown_ids() {
        let text = r#"{"games":{"gameAccounts":[{"titleId":5730135,"gameAccountStatus":"Good"},{"titleId":4613486},{"titleId":1}]},"classic":{"classicGames":[{"localizedGameName":"Diablo® II"}]}}"#;
        let games = account_games(text);
        assert!(games.iter().any(|(id, name)| id == "wow" && name == "World of Warcraft"));
        assert!(games.iter().any(|(id, _)| id == "wow_classic"));
        assert!(games.iter().any(|(id, _)| id == "fenris"));
        assert!(games.iter().any(|(id, _)| id == "d2"));
        assert!(games.iter().all(|(id, _)| id != "1"));
        let as_text = r#"{"gameAccounts":[{"titleId":"5730135"}]}"#;
        assert!(account_games(as_text).iter().any(|(id, _)| id == "wow"));
    }
}
