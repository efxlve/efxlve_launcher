use std::path::Path;

use crate::legendary::models::{AchievementItem, GameAchievementsResponse};

use super::achievements::*;
use super::catalog::*;
use super::cloud::*;
use super::library::*;
use super::playtime::*;
use super::protocol::*;
use super::runtime::*;
use super::shots::*;
use super::users::*;
use super::vdf::*;

#[test]
fn store_language_rejects_path_separators() {
    assert!(safe_store_language("english".into()).is_ok());
    assert!(safe_store_language("schinese".into()).is_ok());
    assert!(safe_store_language("../x".into()).is_err());
    assert!(safe_store_language(r"..\x".into()).is_err());
    assert!(safe_store_language(String::new()).is_err());
    assert!(safe_store_language("en glish".into()).is_err());
}

const LIBRARY_FOLDERS: &str = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"123456789"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		"Games"
	}
}
"#;

const APP_MANIFEST: &str = r#"
"AppState"
{
	"appid"		"620"
	"Universe"		"1"
	"name"		"Portal 2"
	"installdir"		"Portal 2"
	"SizeOnDisk"		"12345678901"
	"StateFlags"		"4"
}
"#;

#[test]
fn vdf_parser_reads_nested_objects() {
    let root = parse_vdf(LIBRARY_FOLDERS);
    let folders = root.get("libraryfolders").expect("libraryfolders node");
    assert_eq!(folders.entries().len(), 2);
    assert_eq!(
        folders
            .get("0")
            .and_then(|f| f.get("path"))
            .and_then(Vdf::as_str),
        Some(r"C:\Program Files (x86)\Steam")
    );
    assert_eq!(
        folders
            .get("1")
            .and_then(|f| f.get("label"))
            .and_then(Vdf::as_str),
        Some("Games")
    );
}

#[test]
fn app_manifest_reads_game_fields() {
    let game =
        parse_app_manifest(APP_MANIFEST, Path::new(r"D:\SteamLibrary\steamapps")).expect("game");
    assert_eq!(game.app_id, "620");
    assert_eq!(game.name, "Portal 2");
    assert_eq!(game.install_dir, "Portal 2");
    assert_eq!(game.size_bytes, 12_345_678_901);
    assert_eq!(game.state_flags, 4);
    assert_eq!(game.bytes_downloaded, 0);
    assert_eq!(game.bytes_to_download, 0);
    assert!(game.library.ends_with("steamapps"));
    assert!(!game.preloaded);
}

#[test]
fn preload_manifest_is_not_an_update() {
    let preload = r#"
"AppState"
{
	"appid"		"3962600"
	"name"		"AION 2"
	"installdir"		"AION2"
	"StateFlags"		"6"
	"buildid"		"17000001"
	"TargetBuildID"		"0"
	"BytesToDownload"		"0"
	"BytesToStage"		"0"
}
"#;
    let game = parse_app_manifest(preload, Path::new("x")).expect("game");
    assert!(game.preloaded);
    assert_eq!(game.state_flags, 6);
}

#[test]
fn real_update_with_a_newer_build_is_not_a_preload() {
    let update = r#"
"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"StateFlags"		"6"
	"buildid"		"100"
	"TargetBuildID"		"200"
	"BytesToDownload"		"0"
	"BytesToStage"		"0"
}
"#;
    let game = parse_app_manifest(update, Path::new("x")).expect("game");
    assert!(!game.preloaded);
}

#[test]
fn queued_bytes_keep_an_update_even_without_a_target_build() {
    let update = r#"
"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"StateFlags"		"6"
	"buildid"		"100"
	"TargetBuildID"		"0"
	"BytesToDownload"		"4096"
}
"#;
    let game = parse_app_manifest(update, Path::new("x")).expect("game");
    assert!(!game.preloaded);
}

#[test]
fn broken_or_empty_documents_never_panic() {
    assert!(parse_app_manifest("", Path::new("x")).is_none());
    assert!(parse_app_manifest("\"AppState\" { \"name\"", Path::new("x")).is_none());
    assert_eq!(parse_vdf("not vdf at all").entries().len(), 0);
    assert_eq!(
        parse_app_manifest(APP_MANIFEST, Path::new("x"))
            .unwrap()
            .app_id,
        "620"
    );
}

const REMOTECACHE: &str = r#"
"730"
{
	"save.dat"
	{
		"size"		"12"
		"localtime"		"1700000000"
		"time"		"1700000100"
		"remotetime"		"1700000200"
	}
}
"#;

const APP_MANIFEST_DOWNLOADING: &str = r#"
"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"installdir"		"Counter-Strike Global Offensive"
	"SizeOnDisk"		"100"
	"StateFlags"		"1026"
	"BytesToDownload"		"4000"
	"BytesDownloaded"		"1000"
}
"#;

#[test]
fn remotecache_reads_newest_unix_time() {
    let root = parse_vdf(REMOTECACHE);
    assert_eq!(max_sync_unix(&root), Some(1_700_000_200));
}

#[test]
fn steamid64_becomes_account_id() {
    assert_eq!(
        account_id_from_steam64("76561197960265729").as_deref(),
        Some("1")
    );
    assert_eq!(account_id_from_steam64("12345").as_deref(), Some("12345"));
}

#[test]
fn app_manifest_reads_download_bytes_without_treating_them_as_live() {
    let game = parse_app_manifest(APP_MANIFEST_DOWNLOADING, Path::new("x")).expect("game");
    assert_eq!(game.app_id, "730");
    assert_eq!(game.bytes_downloaded, 1000);
    assert_eq!(game.bytes_to_download, 4000);
    assert_eq!(game.state_flags, 1026);
    assert!(!game.downloading);
}

#[test]
fn downloading_folder_marks_a_live_download() {
    let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-{}", std::process::id()));
    let dl = tmp.join("downloading").join("730");
    std::fs::create_dir_all(&dl).expect("temp downloading dir");
    let game = parse_app_manifest(APP_MANIFEST_DOWNLOADING, &tmp).expect("game");
    assert!(game.downloading);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn paused_download_is_not_marked_downloading() {
    let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-paused-{}", std::process::id()));
    let dl = tmp.join("downloading").join("730");
    std::fs::create_dir_all(&dl).expect("temp downloading dir");
    let paused_vdf = r#"
"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"StateFlags"		"1538"
	"BytesToDownload"		"4000"
	"BytesDownloaded"		"1000"
}
"#;
    let game = parse_app_manifest(paused_vdf, &tmp).expect("game");
    assert!(!game.downloading);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn staging_bytes_used_when_download_bytes_zero() {
    let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-staging-{}", std::process::id()));
    let dl = tmp.join("downloading").join("730");
    std::fs::create_dir_all(&dl).expect("temp downloading dir");
    let staging_vdf = r#"
"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"StateFlags"		"1026"
	"BytesToDownload"		"0"
	"BytesDownloaded"		"0"
	"BytesToStage"		"8000"
	"BytesStaged"		"4000"
}
"#;
    let game = parse_app_manifest(staging_vdf, &tmp).expect("game");
    assert!(game.downloading);
    assert_eq!(game.bytes_to_download, 8000);
    assert_eq!(game.bytes_downloaded, 4000);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn steam_pid_file_ignores_junk() {
    assert_eq!(parse_steam_pid("1234\r\n"), Some(1234));
    assert_eq!(parse_steam_pid("0"), None);
    assert_eq!(parse_steam_pid("nope"), None);
    assert_eq!(parse_steam_pid(""), None);
}

#[test]
fn steamworks_redistributables_are_not_games() {
    assert!(is_steam_library_noise("228980", "Anything"));
    assert!(is_steam_library_noise(
        "1",
        "Steamworks Common Redistributables"
    ));
    assert!(is_steam_library_noise("0", "Proton 9.0"));
    assert!(!is_steam_library_noise("730", "Counter-Strike 2"));
    assert!(!is_steam_library_noise(
        "2322010",
        "Grand Theft Auto V Enhanced"
    ));
}

#[test]
fn actions_reject_bad_input() {
    assert!(steam_game_action("620; rm -rf".into(), "launch".into()).is_err());
    assert!(steam_game_action(String::new(), "launch".into()).is_err());
    assert!(steam_game_action("620".into(), "delete-everything".into()).is_err());
}

#[test]
fn steam_action_urls_keep_the_verb_and_app_id() {
    assert_eq!(
        steam_action_url("730", "install").as_deref(),
        Some("steam://install/730")
    );
    assert_eq!(
        steam_action_url("730", "update").as_deref(),
        Some("steam://rungameid/730")
    );
    assert_eq!(
        steam_action_url("730", "launch").as_deref(),
        Some("steam://rungameid/730")
    );
    assert!(steam_action_url("730", "delete-everything").is_none());
}

#[test]
fn html_is_flattened_into_clean_lines() {
    let html = "<strong>Minimum:</strong><br><ul class=\"bb_ul\"><li>OS: Windows 10</li><li>Memory: 8 GB &amp; up</li></ul>";
    assert_eq!(
        strip_html(html),
        "Minimum:\nOS: Windows 10\nMemory: 8 GB & up"
    );
    assert_eq!(strip_html(""), "");
}

#[test]
fn appinfo_dlc_ids_come_from_the_client_cache() {
    fn key(index: u32) -> [u8; 4] {
        index.to_le_bytes()
    }
    let mut vdf = Vec::new();
    vdf.push(0);
    vdf.extend_from_slice(&key(0)); // "appinfo"
    vdf.push(0);
    vdf.extend_from_slice(&key(1)); // "extended"
    vdf.push(1);
    vdf.extend_from_slice(&key(2)); // "listofdlc"
    vdf.extend_from_slice(b"329880,329910,432670\0");
    vdf.push(8);
    vdf.push(8);
    vdf.push(8);

    let entry_size = 60 + vdf.len();
    let table_offset = 16 + 8 + entry_size;
    let mut data = Vec::new();
    data.extend_from_slice(&APPINFO_MAGIC_V41.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&(table_offset as u64).to_le_bytes());
    data.extend_from_slice(&319630u32.to_le_bytes());
    data.extend_from_slice(&(entry_size as u32).to_le_bytes());
    data.extend_from_slice(&[0u8; 60]);
    data.extend_from_slice(&vdf);
    data.extend_from_slice(&3u32.to_le_bytes());
    data.extend_from_slice(b"appinfo\0extended\0listofdlc\0");

    assert_eq!(
        parse_appinfo_dlc_ids(&data, "319630"),
        vec!["329880", "329910", "432670"]
    );
    assert!(parse_appinfo_dlc_ids(&data, "730").is_empty());
    assert!(parse_appinfo_dlc_ids(b"junk", "730").is_empty());
}

#[test]
fn appinfo_preloadonly_is_collected() {
    fn key(index: u32) -> [u8; 4] {
        index.to_le_bytes()
    }
    let mut vdf = Vec::new();
    vdf.push(0);
    vdf.extend_from_slice(&key(0)); // common
    vdf.push(1);
    vdf.extend_from_slice(&key(1)); // releasestate
    vdf.extend_from_slice(b"preloadonly\0");
    vdf.push(8);
    vdf.push(8);

    let entry_size = 60 + vdf.len();
    let table_offset = 16 + 8 + entry_size;
    let mut data = Vec::new();
    data.extend_from_slice(&APPINFO_MAGIC_V41.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&(table_offset as u64).to_le_bytes());
    data.extend_from_slice(&3962600u32.to_le_bytes());
    data.extend_from_slice(&(entry_size as u32).to_le_bytes());
    data.extend_from_slice(&[0u8; 60]);
    data.extend_from_slice(&vdf);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(b"common\0releasestate\0");

    let ids = parse_appinfo_preload_ids(&data);
    assert!(ids.contains(&3962600));
    assert_eq!(ids.len(), 1);
}

#[test]
fn global_percentages_apply_rarity_to_local_achievements() {
    let payload = serde_json::json!({
        "achievementpercentages": {
            "achievements": [
                { "name": "AC_1", "percent": 3.5 },
                { "name": "AC_2", "percent": "40.0" }
            ]
        }
    });
    let percentages = parse_global_percentages(&payload);
    assert_eq!(percentages.get("AC_1"), Some(&3.5));
    assert_eq!(percentages.get("AC_2"), Some(&40.0));

    let mut response = GameAchievementsResponse {
        achievements: vec![
            AchievementItem {
                name: "AC_1".into(),
                ..Default::default()
            },
            AchievementItem {
                name: "AC_2".into(),
                ..Default::default()
            },
            AchievementItem {
                name: "AC_3".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    apply_rarity(&mut response, &percentages);
    assert_eq!(
        response.achievements[0]
            .tier
            .as_ref()
            .map(|t| t.name.as_str()),
        Some("gold")
    );
    assert_eq!(
        response.achievements[1]
            .tier
            .as_ref()
            .map(|t| t.name.as_str()),
        Some("bronze")
    );
    assert_eq!(
        response.achievements[1]
            .rarity
            .as_ref()
            .and_then(|r| r.percent),
        Some(40.0)
    );
    assert!(response.achievements[2].tier.is_none());
}

#[test]
fn label_only_requirement_lines_join_with_their_values() {
    // Real Steam pages use `<strong>OS:</strong> Windows 10`; strip_html
    // splits that into "OS:" and "Windows 10".
    let html = "<strong>Minimum:</strong><br><ul class=\"bb_ul\"><li><strong>OS:</strong> Windows® 10<br></li>\
        <li><strong>Processor:</strong> 4 hardware CPU threads - Intel® Core™ i5 750 or higher<br></li>\
        <li><strong>Additional Notes:</strong> <br></li></ul>";
    let raw: Vec<String> = strip_html(html)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let lines = join_label_lines(raw);
    assert_eq!(lines[0], "Minimum:");
    assert_eq!(lines[1], "OS: Windows® 10");
    assert_eq!(
        lines[2],
        "Processor: 4 hardware CPU threads - Intel® Core™ i5 750 or higher"
    );
    assert_eq!(lines[3], "Additional Notes:");

    let data = serde_json::json!({
        "name": "Counter-Strike 2",
        "pc_requirements": { "minimum": html }
    });
    let details = parse_app_details("730", &data);
    assert!(details
        .requirements_min
        .iter()
        .any(|l| l.starts_with("OS: ")));
    assert!(details
        .requirements_min
        .iter()
        .any(|l| l.starts_with("Processor: ")));
}

#[test]
fn app_details_map_to_the_game_page_shape() {
    let data = serde_json::json!({
        "name": "Portal 2",
        "short_description": "Puzzle platformer",
        "detailed_description": "<p>Think with portals</p>",
        "developers": ["Valve"],
        "publishers": ["Valve"],
        "genres": [{ "description": "Action" }, { "description": "Adventure" }],
        "categories": [{ "id": 2, "description": "Single-player" }, { "id": 9, "description": "Co-op" }],
        "release_date": { "date": "18 Apr, 2011" },
        "header_image": "https://cdn/header.jpg",
        "website": "https://thinkwithportals.com",
        "dlc": [1234, 5678],
        "pc_requirements": { "minimum": "<li>OS: Windows 7</li>", "recommended": "<li>OS: Windows 10</li>" }
    });
    let details = parse_app_details("620", &data);
    assert_eq!(details.name, "Portal 2");
    assert_eq!(details.description, "Think with portals");
    assert_eq!(details.genres, vec!["Action", "Adventure"]);
    assert_eq!(details.categories, vec![2, 9]);
    assert_eq!(details.release_date, "18 Apr, 2011");
    assert_eq!(details.dlc, vec!["1234", "5678"]);
    assert_eq!(details.requirements_min, vec!["OS: Windows 7"]);
    assert_eq!(details.requirements_rec, vec!["OS: Windows 10"]);
    assert_eq!(details.ext_user_account_notice, "");
    assert_eq!(details.drm_notice, "");
}

#[test]
fn app_details_keep_third_party_and_drm_notices() {
    let data = serde_json::json!({
        "name": "Battlefield 2042",
        "developers": ["DICE"],
        "publishers": ["Electronic Arts"],
        "ext_user_account_notice": "EA App",
        "drm_notice": "Easy Anti-Cheat"
    });
    let details = parse_app_details("1517290", &data);
    assert_eq!(details.developers, vec!["DICE"]);
    assert_eq!(details.ext_user_account_notice, "EA App");
    assert_eq!(details.drm_notice, "Easy Anti-Cheat");
    assert_eq!(details.metacritic_score, None);
}

#[test]
fn app_details_keep_metacritic_block() {
    let data = serde_json::json!({
        "name": "Portal 2",
        "metacritic": { "score": 95, "url": "https://www.metacritic.com/game/pc/portal-2" }
    });
    let details = parse_app_details("620", &data);
    assert_eq!(details.metacritic_score, Some(95));
    assert_eq!(
        details.metacritic_url.as_deref(),
        Some("https://www.metacritic.com/game/pc/portal-2")
    );
}

#[test]
fn playtimes_are_read_from_the_newest_local_config() {
    let text = r#"
"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"620"
					{
						"LastPlayed"		"1700000000"
						"Playtime"		"90"
					}
					"730"
					{
						"Playtime"		"0"
					}
				}
			}
		}
	}
}
"#;
    let root = parse_vdf(text);
    let apps = root
        .get("UserLocalConfigStore")
        .and_then(|n| n.get("Software"))
        .and_then(|n| n.get("Valve"))
        .and_then(|n| n.get("Steam"))
        .and_then(|n| n.get("apps"))
        .expect("apps node");
    let minutes = apps
        .get("620")
        .and_then(|n| n.get("Playtime"))
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    assert_eq!(minutes * 60, 5400);
    let last = apps
        .get("620")
        .and_then(|n| n.get("LastPlayed"))
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<i64>().ok());
    assert_eq!(last, Some(1_700_000_000));
}

#[test]
fn library_paths_compare_case_insensitively() {
    assert_eq!(
        path_key(Path::new(r"C:/Program Files (x86)/Steam/steamapps/")),
        path_key(Path::new(r"c:\program files (x86)\steam\steamapps"))
    );
}

#[test]
fn login_users_resolve_to_the_most_recent_persona() {
    let text = r#"
"users"
{
	"76561199140017878"
	{
		"AccountName"		"efxlve"
		"PersonaName"		"Efxlve"
		"MostRecent"		"1"
		"Timestamp"		"1700000000"
	}
	"76561198000000000"
	{
		"PersonaName"		"Other"
		"MostRecent"		"0"
	}
}
"#;
    let root = parse_vdf(text);
    let users = root.get("users").expect("users node");
    let mut persona = String::new();
    for (id, node) in users.entries() {
        if node.get("MostRecent").and_then(Vdf::as_str) == Some("1") {
            persona = format!(
                "{id}:{}",
                node.get("PersonaName").and_then(Vdf::as_str).unwrap_or("")
            );
        }
    }
    assert_eq!(persona, "76561199140017878:Efxlve");
}

#[test]
fn unix_seconds_become_civil_dates() {
    assert_eq!(unix_date(0), "");
    assert_eq!(unix_date(1_700_000_000), "2023-11-14");
    assert_eq!(unix_date(1_600_000_000), "2020-09-13");
}

#[test]
fn tiers_follow_the_global_unlock_rate() {
    assert_eq!(tier_for_percent(1.5).name, "gold");
    assert_eq!(tier_for_percent(12.0).name, "silver");
    assert_eq!(tier_for_percent(60.0).name, "bronze");
}

/// Live check for the SteamID and the achievement pipeline (needs the key).
/// Run: `cargo test live_steam_achievements -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_achievements() {
    let Some(path) = steam_install_path() else {
        println!("Steam is not installed on this machine");
        return;
    };
    println!("active steam id: {:?}", active_steam_id(&path));
}

/// Live check against this machine's Steam install.
/// Run: `cargo test live_steam -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_detection() {
    let Some(path) = steam_install_path() else {
        println!("Steam is not installed on this machine");
        return;
    };
    println!("steam: {}", path.display());
    let folders = library_folders(&path);
    println!("libraries: {}", folders.len());
    for folder in &folders {
        println!("  {}", folder.display());
    }
    let games = installed_games(&path);
    println!("installed games: {}", games.len());
    for game in games.iter().take(12) {
        println!(
            "  {} | {} | {} MB | flags {}",
            game.app_id,
            game.name,
            game.size_bytes / 1_048_576,
            game.state_flags
        );
    }
}

#[test]
fn binary_vdf_reads_nested_objects_and_scalars() {
    // Valve KeyValues binary: [type][key]\0[payload]; 0 = subtree, 8 = end.
    let mut data: Vec<u8> = Vec::new();
    data.push(0);
    data.extend_from_slice(b"319630\0");
    data.push(0);
    data.extend_from_slice(b"stats\0");
    data.push(0);
    data.extend_from_slice(b"1\0");
    data.push(0);
    data.extend_from_slice(b"bits\0");
    data.push(0);
    data.extend_from_slice(b"0\0");
    data.push(1); // string
    data.extend_from_slice(b"name\0");
    data.extend_from_slice(b"AC_1\0");
    data.push(2); // int32
    data.extend_from_slice(b"hidden\0");
    data.extend_from_slice(&1i32.to_le_bytes());
    data.push(8); // end bits
    data.push(8); // end group 1
    data.push(8); // end stats
    data.push(8); // end 319630
    data.push(8); // end root object

    let root = parse_binary_vdf(&data).expect("parsed");
    let bit = root
        .get("319630")
        .and_then(|app| app.get("stats"))
        .and_then(|stats| stats.get("1"))
        .and_then(|group| group.get("bits"))
        .and_then(|bits| bits.get("0"))
        .expect("achievement bit");
    assert_eq!(bit.get("name").and_then(Vdf::as_str), Some("AC_1"));
    assert_eq!(bit.get("hidden").and_then(Vdf::as_str), Some("1"));
    assert!(parse_binary_vdf(b"garbage").is_none());
    assert!(parse_binary_vdf(&[0, 1, 2]).is_none());
}

/// Live check of the local achievement cache (needs the Steam client).
/// Run: `cargo test live_steam_local_achievements -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_local_achievements() {
    let Some(steam) = steam_install_path() else {
        println!("Steam is not installed on this machine");
        return;
    };
    println!("steam: {}", steam.display());
    match read_local_achievements(&steam, "319630") {
        Some(response) => println!(
            "319630 (Life is Strange): {}/{} unlocked",
            response.user_unlocked, response.total_achievements
        ),
        None => println!("319630: no local schema"),
    }
    let started = std::time::Instant::now();
    let totals = read_local_achievement_totals(&steam);
    println!(
        "games with local achievement stats: {} in {} ms",
        totals.len(),
        started.elapsed().as_millis()
    );
    for app in ["730", "1240440", "319630", "620", "1097150", "227300"] {
        if let Some((_, unlocked, total)) = totals.iter().find(|(id, _, _)| id == app) {
            println!("  {app}: {unlocked}/{total}");
        }
    }
}

/// Live check for the client's own DLC list (`appcache/appinfo.vdf`).
/// Run: `cargo test live_steam_client_dlc -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_client_dlc() {
    let Some(steam) = steam_install_path() else {
        println!("Steam is not installed on this machine");
        return;
    };
    for app in ["319630", "730", "620"] {
        let ids = read_client_dlc_ids(&steam, app);
        println!("{app}: {} dlc -> {ids:?}", ids.len());
    }
}

/// Live check for the client's own screenshots.
/// Run: `cargo test live_steam_screenshots -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_screenshots() {
    for app in ["730", "359550", "381210"] {
        let items = steam_get_game_screenshots(app.to_string());
        println!("{app}: {} screenshots", items.len());
        for item in items.iter().take(3) {
            println!(
                "  {} | {} | {} | thumb {} | full {}",
                item.file_name,
                item.date_str,
                item.size_str,
                item.data_url.len(),
                item.full_data_url.len()
            );
        }
    }
}

/// Live check for playtime + store details (network).
/// Run: `cargo test live_steam_playtime_and_details -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_playtime_and_details() {
    let Some(path) = steam_install_path() else {
        println!("Steam is not installed on this machine");
        return;
    };
    let playtimes = read_playtimes(&path);
    println!("playtime records: {}", playtimes.len());
    for (app_id, record) in playtimes.iter().take(10) {
        println!(
            "  {app_id} | {} min | last {:?}",
            record.seconds / 60,
            record.last_played
        );
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    let details = rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("efxlve-launcher")
            .build()
            .unwrap();
        let payload: serde_json::Value = client
            .get("https://store.steampowered.com/api/appdetails?appids=620&l=english")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        parse_app_details("620", payload.get("620").unwrap().get("data").unwrap())
    });
    println!(
        "details: {} | {} | genres {:?} | min req {} lines",
        details.name,
        details.release_date,
        details.genres,
        details.requirements_min.len()
    );
}

#[test]
fn cloud_status_rejects_a_path() {
    let status = steam_cloud_status(r"..\Windows".into());
    assert!(status.last_sync.is_none());
    assert!(status.app_id.is_empty());
}

#[test]
fn steam_uri_rejects_shell_metacharacters() {
    assert!(spawn_uri("https://example.com").is_err());
    assert!(spawn_uri("steam://run/1&calc").is_err());
    assert!(spawn_uri("steam://open/main\ncmd").is_err());
}
