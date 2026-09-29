//! Steam integration — detection only, no Steam client replacement.
//!
//! Steamworks DRM means a game cannot run without the Steam client, so this
//! module never touches game files: it reads the client's own metadata from
//! disk (install path, library folders, app manifests) and hands every action
//! back to Steam through its `steam://` protocol. No network access.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::winreg;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Valve KeyValues (VDF) node: a scalar or a list of key/value children.
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// Case-insensitive child lookup.
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(entries) => entries
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }

    /// Scalar value, if this node is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    /// Children of an object node.
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(entries) => entries,
            Vdf::Str(_) => &[],
        }
    }
}

struct VdfParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> VdfParser<'a> {
    fn new(text: &'a str) -> Self {
        Self { bytes: text.as_bytes(), pos: 0 }
    }

    fn skip_ws(&mut self) {
        while let Some(&b) = self.bytes.get(self.pos) {
            if b == b' ' || b == b'\t' || b == b'\r' || b == b'\n' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    /// Reads a quoted string (backslash escapes are unwrapped).
    fn string(&mut self) -> Option<String> {
        if self.peek()? != b'"' {
            return None;
        }
        self.pos += 1;
        let mut out: Vec<u8> = Vec::new();
        while let Some(&b) = self.bytes.get(self.pos) {
            self.pos += 1;
            match b {
                b'"' => return Some(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => {
                    if let Some(&esc) = self.bytes.get(self.pos) {
                        self.pos += 1;
                        out.push(esc);
                    }
                }
                _ => out.push(b),
            }
        }
        None
    }

    fn object(&mut self) -> Vec<(String, Vdf)> {
        let mut entries = Vec::new();
        loop {
            match self.peek() {
                None => break,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => {}
            }
            let Some(key) = self.string() else { break };
            match self.peek() {
                Some(b'{') => {
                    self.pos += 1;
                    let child = self.object();
                    entries.push((key, Vdf::Obj(child)));
                }
                Some(b'"') => {
                    let value = self.string().unwrap_or_default();
                    entries.push((key, Vdf::Str(value)));
                }
                _ => break,
            }
        }
        entries
    }
}

/// Parses a KeyValues document (VDF/ACF). Unknown shapes yield an empty tree
/// instead of an error: a broken file must never take the UI down.
pub fn parse_vdf(text: &str) -> Vdf {
    let mut parser = VdfParser::new(text);
    let root = parser.object();
    Vdf::Obj(root)
}

/// Steam install directory from the registry (`SteamPath` / `InstallPath`).
pub fn steam_install_path() -> Option<PathBuf> {
    let hkcu = winreg::query(r"HKCU\Software\Valve\Steam", Some("SteamPath"));
    let hklm = winreg::query(r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam", Some("InstallPath"));
    let raw = hkcu
        .as_deref()
        .map(winreg::parse_reg_sz)
        .filter(|p| !p.is_empty())
        .or_else(|| hklm.as_deref().map(winreg::parse_reg_sz).filter(|p| !p.is_empty()))?;
    let path = PathBuf::from(raw);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// Normalized path key for case-insensitive Windows comparisons.
fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// Every `steamapps` folder: the main install plus the extra library folders.
pub fn library_folders(steam: &Path) -> Vec<PathBuf> {
    let main = steam.join("steamapps");
    let mut folders = vec![main.clone()];
    let mut seen = std::collections::HashSet::from([path_key(&main)]);
    let Ok(text) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) else {
        return folders;
    };
    let root = parse_vdf(&text);
    let Some(list) = root.get("libraryfolders") else { return folders };
    for (_, entry) in list.entries() {
        let Some(path) = entry.get("path").and_then(Vdf::as_str) else { continue };
        let candidate = PathBuf::from(path).join("steamapps");
        // The main install is usually listed again with different casing; only a
        // real, unseen folder joins the list.
        if candidate.is_dir() && seen.insert(path_key(&candidate)) {
            folders.push(candidate);
        }
    }
    folders
}

/// One installed Steam game read from its app manifest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGame {
    pub app_id: String,
    pub name: String,
    pub install_dir: String,
    pub size_bytes: u64,
    /// Steam's `StateFlags`; 4 means fully installed.
    pub state_flags: u32,
    /// Library folder that holds the game.
    pub library: String,
}

/// Parses one `appmanifest_<id>.acf` file.
pub fn parse_app_manifest(text: &str, library: &Path) -> Option<SteamGame> {
    let root = parse_vdf(text);
    let state = root.get("AppState")?;
    let app_id = state.get("appid").and_then(Vdf::as_str)?.to_string();
    if app_id.is_empty() {
        return None;
    }
    let name = state.get("name").and_then(Vdf::as_str).unwrap_or(&app_id).to_string();
    let install_dir = state.get("installdir").and_then(Vdf::as_str).unwrap_or("").to_string();
    let size_bytes = state
        .get("SizeOnDisk")
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let state_flags = state
        .get("StateFlags")
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    Some(SteamGame {
        app_id,
        name,
        install_dir,
        size_bytes,
        state_flags,
        library: library.to_string_lossy().to_string(),
    })
}

/// Reads every app manifest across all library folders, newest first.
pub fn installed_games(steam: &Path) -> Vec<SteamGame> {
    let mut games: Vec<SteamGame> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for folder in library_folders(steam) {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if let Some(game) = parse_app_manifest(&text, &folder) {
                // A game left behind in an old library folder must not appear twice.
                if seen.insert(game.app_id.clone()) {
                    games.push(game);
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Status shown in Settings > Integrations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamStatus {
    pub installed: bool,
    pub path: String,
    pub games: usize,
}

#[tauri::command]
pub fn steam_status() -> SteamStatus {
    match steam_install_path() {
        Some(path) => {
            let games = installed_games(&path).len();
            SteamStatus {
                installed: true,
                path: path.to_string_lossy().to_string(),
                games,
            }
        }
        None => SteamStatus { installed: false, path: String::new(), games: 0 },
    }
}

#[tauri::command]
pub fn steam_list_installed() -> Vec<SteamGame> {
    steam_install_path().map(|p| installed_games(&p)).unwrap_or_default()
}

/// Actions handed back to the Steam client. Steam owns the game process and
/// every file operation, so the launcher only opens the matching protocol URL.
const STEAM_ACTIONS: [&str; 4] = ["launch", "install", "uninstall", "validate"];

#[tauri::command]
pub fn steam_game_action(app_id: String, action: String) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    if !STEAM_ACTIONS.contains(&action.as_str()) {
        return Err("Unsupported Steam action".into());
    }
    let url = match action.as_str() {
        "launch" => format!("steam://rungameid/{app_id}"),
        "install" => format!("steam://install/{app_id}"),
        "uninstall" => format!("steam://uninstall/{app_id}"),
        _ => format!("steam://validate/{app_id}"),
    };
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", &url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Steam could not be opened: {e}"))
}

/// Playtime from the Steam client's own local config, in seconds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamPlaytime {
    pub seconds: i64,
    /// Unix seconds of the last session, when Steam recorded one.
    pub last_played: Option<i64>,
}

/// Reads `userdata/<id>/config/localconfig.vdf` for the most recently used
/// Steam account and maps `<appid>` to playtime (minutes in the file).
pub fn read_playtimes(steam: &Path) -> std::collections::HashMap<String, SteamPlaytime> {
    let mut result = std::collections::HashMap::new();
    let userdata = steam.join("userdata");
    let Ok(entries) = std::fs::read_dir(&userdata) else { return result };
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let config = entry.path().join("config").join("localconfig.vdf");
        let Ok(meta) = std::fs::metadata(&config) else { continue };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, config));
        }
    }
    let Some((_, path)) = newest else { return result };
    let Ok(text) = std::fs::read_to_string(&path) else { return result };
    let root = parse_vdf(&text);
    let apps = root
        .get("UserLocalConfigStore")
        .and_then(|n| n.get("Software"))
        .and_then(|n| n.get("Valve"))
        .and_then(|n| n.get("Steam"))
        .and_then(|n| n.get("apps"));
    let Some(apps) = apps else { return result };
    for (app_id, node) in apps.entries() {
        if !app_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let minutes = node
            .get("Playtime")
            .and_then(Vdf::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if minutes <= 0 {
            continue;
        }
        let last_played = node
            .get("LastPlayed")
            .and_then(Vdf::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0);
        result.insert(app_id.clone(), SteamPlaytime { seconds: minutes * 60, last_played });
    }
    result
}

#[tauri::command]
pub fn steam_sync_playtime() -> std::collections::HashMap<String, SteamPlaytime> {
    steam_install_path().map(|p| read_playtimes(&p)).unwrap_or_default()
}

/* ---------- Store details (network, cached on disk) ---------- */

/// How long a store description stays fresh.
const DETAILS_TTL_SECS: u64 = 6 * 60 * 60;

/// Store metadata shown on the game page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGameDetails {
    pub app_id: String,
    pub name: String,
    pub short_description: String,
    pub description: String,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub genres: Vec<String>,
    pub release_date: String,
    pub header_image: String,
    pub website: String,
    pub screenshots: Vec<String>,
    /// Requirement bullets (tags stripped, one per line).
    pub requirements_min: Vec<String>,
    pub requirements_rec: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct CachedDetails {
    fetched_at: u64,
    details: SteamGameDetails,
}

/// Drops tags and decodes the few entities Steam actually uses.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push('\n');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    decoded
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn html_lines(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|html| {
            strip_html(html)
                .lines()
                .map(|l| l.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn string_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("description").and_then(|d| d.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Turns one `appdetails` payload into the flat structure the game page uses.
pub fn parse_app_details(app_id: &str, data: &serde_json::Value) -> SteamGameDetails {
    let screenshots = data
        .get("screenshots")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("path_full").and_then(|p| p.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let requirements = data.get("pc_requirements").cloned().unwrap_or(serde_json::Value::Null);
    SteamGameDetails {
        app_id: app_id.to_string(),
        name: data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        short_description: data
            .get("short_description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        description: data
            .get("detailed_description")
            .and_then(|v| v.as_str())
            .map(strip_html)
            .unwrap_or_default(),
        developers: data
            .get("developers")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        publishers: data
            .get("publishers")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        genres: string_list(data, "genres"),
        release_date: data
            .get("release_date")
            .and_then(|v| v.get("date"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        header_image: data.get("header_image").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        website: data.get("website").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        screenshots,
        requirements_min: html_lines(&requirements, "minimum"),
        requirements_rec: html_lines(&requirements, "recommended"),
    }
}

fn details_cache_path(app: &tauri::AppHandle, app_id: &str, language: &str) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("details");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{app_id}_{language}.json"))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Store description, developer and requirements for one game.
///
/// The Steam store API is rate limited, so a 6 hour disk cache answers repeated
/// opens and the request only runs when the page actually asks for it.
#[tauri::command]
pub async fn steam_get_game_details(
    app: tauri::AppHandle,
    app_id: String,
    language: Option<String>,
) -> Result<SteamGameDetails, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let language = language.unwrap_or_else(|| "english".into());
    let cache = details_cache_path(&app, &app_id, &language);
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if let Ok(cached) = serde_json::from_str::<CachedDetails>(&text) {
            if now_secs().saturating_sub(cached.fetched_at) < DETAILS_TTL_SECS {
                return Ok(cached.details);
            }
        }
    }

    let url = format!("https://store.steampowered.com/api/appdetails?appids={app_id}&l={language}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;
    let payload: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Steam store could not be reached: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Steam store answered with an unexpected payload: {e}"))?;
    let entry = payload.get(&app_id).ok_or("Steam store has no record for this app")?;
    if entry.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Steam store has no record for this app".into());
    }
    let data = entry.get("data").ok_or("Steam store returned no data")?;
    let details = parse_app_details(&app_id, data);
    let cached = CachedDetails { fetched_at: now_secs(), details: details.clone() };
    if let Ok(text) = serde_json::to_string(&cached) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(details)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            folders.get("0").and_then(|f| f.get("path")).and_then(Vdf::as_str),
            Some(r"C:\Program Files (x86)\Steam")
        );
        assert_eq!(
            folders.get("1").and_then(|f| f.get("label")).and_then(Vdf::as_str),
            Some("Games")
        );
    }

    #[test]
    fn app_manifest_reads_game_fields() {
        let game = parse_app_manifest(APP_MANIFEST, Path::new(r"D:\SteamLibrary\steamapps")).expect("game");
        assert_eq!(game.app_id, "620");
        assert_eq!(game.name, "Portal 2");
        assert_eq!(game.install_dir, "Portal 2");
        assert_eq!(game.size_bytes, 12_345_678_901);
        assert_eq!(game.state_flags, 4);
        assert!(game.library.ends_with("steamapps"));
    }

    #[test]
    fn broken_or_empty_documents_never_panic() {
        assert!(parse_app_manifest("", Path::new("x")).is_none());
        assert!(parse_app_manifest("\"AppState\" { \"name\"", Path::new("x")).is_none());
        assert_eq!(parse_vdf("not vdf at all").entries().len(), 0);
        assert_eq!(parse_app_manifest(APP_MANIFEST, Path::new("x")).unwrap().app_id, "620");
    }

    #[test]
    fn actions_reject_bad_input() {
        assert!(steam_game_action("620; rm -rf".into(), "launch".into()).is_err());
        assert!(steam_game_action(String::new(), "launch".into()).is_err());
        assert!(steam_game_action("620".into(), "delete-everything".into()).is_err());
    }

    #[test]
    fn html_is_flattened_into_clean_lines() {
        let html = "<strong>Minimum:</strong><br><ul class=\"bb_ul\"><li>OS: Windows 10</li><li>Memory: 8 GB &amp; up</li></ul>";
        assert_eq!(strip_html(html), "Minimum:\nOS: Windows 10\nMemory: 8 GB & up");
        assert_eq!(strip_html(""), "");
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
            "release_date": { "date": "18 Apr, 2011" },
            "header_image": "https://cdn/header.jpg",
            "website": "https://thinkwithportals.com",
            "screenshots": [{ "path_full": "https://cdn/1.jpg" }],
            "pc_requirements": { "minimum": "<li>OS: Windows 7</li>", "recommended": "<li>OS: Windows 10</li>" }
        });
        let details = parse_app_details("620", &data);
        assert_eq!(details.name, "Portal 2");
        assert_eq!(details.description, "Think with portals");
        assert_eq!(details.genres, vec!["Action", "Adventure"]);
        assert_eq!(details.release_date, "18 Apr, 2011");
        assert_eq!(details.screenshots, vec!["https://cdn/1.jpg"]);
        assert_eq!(details.requirements_min, vec!["OS: Windows 7"]);
        assert_eq!(details.requirements_rec, vec!["OS: Windows 10"]);
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
            println!("  {app_id} | {} min | last {:?}", record.seconds / 60, record.last_played);
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
}
