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
}
