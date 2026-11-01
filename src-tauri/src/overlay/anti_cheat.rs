//! Conservative anti-cheat detection for the overlay.
//!
//! Nothing here injects or hooks a game. The overlay is external, but a
//! competitive title must never have even that extra surface: if the title or
//! its install folder names an anti-cheat, the overlay is forced off for the
//! whole session. The list is deliberately broader than the current catalogue.

/// Titles known to ship a kernel or competitive anti-cheat. Lowercase
/// substrings; the game title comes from the store, not from the process name.
const TITLES: &[&str] = &[
    "rainbow six siege",
    "rainbow six® siege",
    "rainbow six extraction",
    "grand theft auto v",
    "gta v",
    "gta online",
    "battlefield 2042",
    "apex legends",
    "fortnite",
    "destiny 2",
    "ark: survival",
    "fall guys",
    "dead by daylight",
    "hell let loose",
    "the finals",
    "ghost recon breakpoint",
    "ghost recon wildlands",
    "for honor",
    "the division 2",
    "paladins",
    "smite",
    "rogue company",
    "war thunder",
    "elden ring",
    "squad",
    "hunt: showdown",
    "chivalry 2",
    "conan exiles",
    "dayz",
    "star wars squadrons",
    "counter-strike",
    "counter strike",
    "cs2",
    "valorant",
    "league of legends",
    "escape from tarkov",
    "rust",
    "pubg",
    "playerunknown",
    "overwatch",
    "call of duty",
    "warzone",
    "naraka",
    "new world",
    "lost ark",
    "delta force",
    "marvel rivals",
    "once human",
    "the first descendant",
    "gray zone warfare",
    "arena breakout",
    "dark and darker",
    "deadlock",
    "dota 2",
    "team fortress",
    "left 4 dead",
];

/// Files or folders an anti-cheat install leaves beside the game.
const FILES: &[&str] = &[
    "BattlEye",
    "BEService.exe",
    "BEService_x64.exe",
    "BEClient_x64.dll",
    "BEClient.dll",
    "RainbowSix_BE.exe",
    "EasyAntiCheat",
    "EasyAntiCheat_EOS",
    "EasyAntiCheat.exe",
    "EasyAntiCheat_EOS.exe",
    "start_protected_game.exe",
    "vgc.exe",
    "vgk.sys",
    "Vanguard",
    "XignCode",
    "x3.xem",
    "XignCode.exe",
    "GameGuard",
    "GameMon.des",
    "npggNT.des",
    "mhyprot",
    "mhyprot2.sys",
    "HoYoProtect",
    "AntiCheatExpert",
    "SGuard64.exe",
    "ACE-Tray.exe",
    "PunkBuster",
    "PnkBstrA.exe",
    "FairFight",
    "Ricochet",
];

/// True when this title or its install folder names an anti-cheat.
pub(crate) fn game_has_anti_cheat(title: &str, install_path: Option<&str>) -> bool {
    let title = title.trim().to_lowercase();
    if !title.is_empty() && TITLES.iter().any(|needle| title.contains(needle)) {
        return true;
    }
    let Some(path) = install_path.filter(|path| !path.trim().is_empty()) else {
        return false;
    };
    let root = std::path::Path::new(path);
    let mut budget = 2000usize;
    has_marker(root, 0, &mut budget)
}

/// Bounded recursive search for an anti-cheat folder or file. Real games keep
/// BattlEye under `Binaries/Win64` and EAC under `EasyAntiCheat`, so a root-only
/// check would miss Unreal titles. The budget keeps a game start cheap.
fn has_marker(directory: &std::path::Path, depth: u32, budget: &mut usize) -> bool {
    if depth > 3 || *budget == 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if FILES.iter().any(|marker| name == marker.to_lowercase()) {
            return true;
        }
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            && has_marker(&entry.path(), depth + 1, budget)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_titles_are_blocked_regardless_of_store() {
        assert!(game_has_anti_cheat("Tom Clancy's Rainbow Six® Siege", None));
        assert!(game_has_anti_cheat("Grand Theft Auto V Enhanced", None));
        assert!(game_has_anti_cheat("Counter-Strike 2", None));
        assert!(!game_has_anti_cheat("Rayman Origins", None));
        assert!(!game_has_anti_cheat("The Wolf Among Us Remastered", None));
    }

    #[test]
    #[ignore = "reads the installed Rainbow Six folder"]
    fn live_r6_is_blocked_by_title_and_folder() {
        let path = r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games\Tom Clancy's Rainbow Six Siege";
        assert!(game_has_anti_cheat(
            "Tom Clancy's Rainbow Six® Siege",
            Some(path)
        ));
        assert!(game_has_anti_cheat(
            "Tom Clancy's Rainbow Six Siege",
            Some(path)
        ));
        assert!(!game_has_anti_cheat("Rayman Origins", None));
    }

    #[test]
    fn an_anti_cheat_folder_blocks_an_unknown_title() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-anti-cheat-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("Binaries").join("Win64").join("BattlEye");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(game_has_anti_cheat(
            "Unknown Shooter",
            Some(&root.display().to_string())
        ));
        std::fs::remove_dir_all(root.join("Binaries")).unwrap();
        assert!(!game_has_anti_cheat(
            "Unknown Shooter",
            Some(&root.display().to_string())
        ));
        let _ = std::fs::remove_dir_all(&root);
    }
}
