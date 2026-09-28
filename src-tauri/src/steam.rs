//! Steam integration — detection only, no Steam client replacement.
//!
//! Steamworks DRM means a game cannot run without the Steam client, so this
//! module never touches game files: it reads the client's own metadata from
//! disk (install path, library folders, app manifests) and hands every action
//! back to Steam through its `steam://` protocol. No network access.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

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

/// Hands the launch to the Steam client. Steam owns the game process, so the
/// launcher never starts the executable itself.
#[tauri::command]
pub fn steam_launch_game(app_id: String) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let url = format!("steam://rungameid/{app_id}");
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
    fn launch_rejects_non_numeric_app_ids() {
        assert!(steam_launch_game("620; rm -rf".into()).is_err());
        assert!(steam_launch_game(String::new()).is_err());
    }

    #[test]
    fn library_paths_compare_case_insensitively() {
        assert_eq!(
            path_key(Path::new(r"C:/Program Files (x86)/Steam/steamapps/")),
            path_key(Path::new(r"c:\program files (x86)\steam\steamapps"))
        );
    }

    /// Live check against this machine's Steam install.
    /// Run: `cargo test live_steam_detection -- --ignored --nocapture`
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
}
