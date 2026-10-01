//! Steam integration — detection only, no Steam client replacement.
//!
//! Steamworks DRM means a game cannot run without the Steam client, so this
//! module never touches game files: it reads the client's own metadata from
//! disk (install path, library folders, app manifests) and hands every action
//! back to Steam through its `steam://` protocol. No network access.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// PID written by the Steam client into `steam.pid`. Zero / junk is ignored.
fn parse_steam_pid(raw: &str) -> Option<u32> {
    let pid = raw.trim().parse::<u32>().ok()?;
    (pid != 0).then_some(pid)
}

/// Last process probe. `installed_games` runs on every manifest write; a missing
/// `steam.pid` (Steam is open but never wrote the file) must not snapshot every
/// process on the machine each time.
static STEAM_RUNNING_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/// True while the Steam client process from `steam.pid` is still alive.
///
/// ACF `StateFlags` and leftover `downloading/` folders survive after Steam
/// exits, so live-download UI must not trust those files unless the client is
/// actually running.
fn steam_client_running(steam: &Path) -> bool {
    if let Ok(slot) = STEAM_RUNNING_CACHE.lock() {
        if let Some((at, running)) = *slot {
            if at.elapsed() < Duration::from_secs(2) {
                return running;
            }
        }
    }
    let running = steam_client_running_now(steam);
    if let Ok(mut slot) = STEAM_RUNNING_CACHE.lock() {
        *slot = Some((Instant::now(), running));
    }
    running
}

fn steam_client_running_now(steam: &Path) -> bool {
    if let Ok(raw) = std::fs::read_to_string(steam.join("steam.pid")) {
        if let Some(pid) = parse_steam_pid(&raw) {
            if pid_is_alive(pid) {
                return true;
            }
        }
    }
    #[cfg(windows)]
    {
        crate::legendary::transfers::is_game_process_running(None, &["steam.exe".to_string()])
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
mod win_pid {
    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    const STILL_ACTIVE: DWORD = 259;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
        fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *mut DWORD) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
    }

    pub fn is_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: DWORD = 0;
            let ok = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            ok && code == STILL_ACTIVE
        }
    }
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    win_pid::is_alive(pid)
}

#[cfg(not(windows))]
fn pid_is_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).is_dir()
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
    /// True while the Steam client is downloading this app (`steamapps/downloading/<id>`).
    pub downloading: bool,
    /// Bytes the client has already pulled (`BytesDownloaded`, else the downloading folder).
    pub bytes_downloaded: u64,
    /// Total bytes this job still reports (`BytesToDownload`). Zero when Steam has not written it.
    pub bytes_to_download: u64,
    /// True when the install is a preload (release build is not out yet).
    /// Steam still sets `UpdateRequired` for those, but there is nothing to download.
    #[serde(default)]
    pub preloaded: bool,
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
    let mut bytes_to_download = acf_u64(state, "BytesToDownload");
    let mut bytes_downloaded = acf_u64(state, "BytesDownloaded");
    let bytes_to_stage = acf_u64(state, "BytesToStage");
    let build_id = acf_u64(state, "buildid");
    let target_build_id = acf_u64(state, "TargetBuildID");
    let dl_dir = library.join("downloading").join(&app_id);
    // Only a live `downloading/<id>` folder means Steam is transferring files.
    // If paused (bit 512 = 0x200), it is not actively downloading.
    // Byte counters come from the manifest. Walking the download folder to sum
    // file sizes blocks the UI for the whole transfer (tens of GB, constantly
    // rewritten while the poller is running).
    let paused = (state_flags & 512) != 0;
    let downloading = dl_dir.is_dir() && !paused;
    if downloading && bytes_to_download == 0 {
        let stage_to = acf_u64(state, "BytesToStage");
        if stage_to > 0 {
            bytes_to_download = stage_to;
            if bytes_downloaded == 0 {
                bytes_downloaded = acf_u64(state, "BytesStaged");
            }
        }
    }
    Some(SteamGame {
        app_id,
        name,
        install_dir,
        size_bytes,
        state_flags,
        library: library.to_string_lossy().to_string(),
        downloading,
        bytes_downloaded,
        bytes_to_download,
        // A preload keeps UpdateRequired set until release day, with no newer
        // build and nothing queued. A real patch names a different TargetBuildID
        // or reports bytes to fetch.
        preloaded: (state_flags & 2) != 0
            && bytes_to_download == 0
            && bytes_to_stage == 0
            && (target_build_id == 0 || target_build_id == build_id),
    })
}

/// Reads every app manifest across all library folders, newest first.
pub fn installed_games(steam: &Path) -> Vec<SteamGame> {
    let mut games: Vec<SteamGame> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let steam_running = steam_client_running(steam);
    let preloads = cached_preload_ids(steam);
    for folder in library_folders(steam) {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if let Some(mut game) = parse_app_manifest(&text, &folder) {
                if is_steam_library_noise(&game.app_id, &game.name) {
                    continue;
                }
                if !steam_running {
                    game.downloading = false;
                }
                if !game.preloaded {
                    if let Ok(id) = game.app_id.parse::<u32>() {
                        if preloads.contains(&id) {
                            game.preloaded = true;
                        }
                    }
                }
                // A game left behind in an old library folder must not appear twice.
                if seen.insert(game.app_id.clone()) {
                    games.push(game);
                }
            }
        }
        // First-time installs create `downloading/<id>` before a full manifest.
        if !steam_running {
            continue;
        }
        if let Ok(dl_entries) = std::fs::read_dir(folder.join("downloading")) {
            for entry in dl_entries.flatten() {
                let id = entry.file_name().to_string_lossy().to_string();
                if !entry.path().is_dir() || !id.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                if is_steam_library_noise(&id, "") {
                    continue;
                }
                if seen.insert(id.clone()) {
                    games.push(SteamGame {
                        app_id: id.clone(),
                        name: id,
                        install_dir: String::new(),
                        size_bytes: 0,
                        state_flags: 0,
                        library: folder.to_string_lossy().to_string(),
                        downloading: true,
                        bytes_downloaded: 0,
                        bytes_to_download: 0,
                        preloaded: false,
                    });
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Tools and SDKs Steam installs next to games (not playable titles).
fn is_steam_library_noise(app_id: &str, name: &str) -> bool {
    if app_id == "228980" {
        return true;
    }
    let n = name.to_ascii_lowercase();
    n.contains("steamworks common redistributables")
        || n.contains("steamworks redistributable")
        || n.starts_with("steam linux runtime")
        || n.starts_with("proton ")
        || n == "proton experimental"
        || n.contains("steamworks sdk")
        || n == "source sdk"
        || n.starts_with("source sdk ")
}

/// Status shown in Settings > Integrations and on the Accounts page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamStatus {
    pub installed: bool,
    pub path: String,
    pub games: usize,
    /// Persona name of the account signed in to the Steam client (empty when unknown).
    pub user_name: String,
}

#[tauri::command]
pub fn steam_status() -> SteamStatus {
    match steam_install_path() {
        Some(path) => {
            let games = installed_games(&path).len();
            let user_name = active_steam_user(&path).map(|(_, name)| name).unwrap_or_default();
            SteamStatus {
                installed: true,
                path: path.to_string_lossy().to_string(),
                games,
                user_name,
            }
        }
        None => SteamStatus {
            installed: false,
            path: String::new(),
            games: 0,
            user_name: String::new(),
        },
    }
}

/// Opens the Steam client itself (`steam://open/main`).
#[tauri::command]
pub fn steam_open_client() -> Result<(), String> {
    spawn_uri("steam://open/main")
}

/// Opens Steam's own download manager (`steam://open/downloads`).
#[tauri::command]
pub fn steam_open_downloads() -> Result<(), String> {
    spawn_uri("steam://open/downloads")
}

#[tauri::command]
pub fn steam_list_installed() -> Vec<SteamGame> {
    steam_install_path().map(|p| installed_games(&p)).unwrap_or_default()
}

/// Last Steam Cloud write time for one app, read from `userdata/.../remotecache.vdf`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamCloudStatus {
    pub app_id: String,
    /// Unix seconds of the newest remotecache timestamp, if Steam wrote one.
    pub last_sync: Option<i64>,
}

const STEAM64_BASE: u64 = 7_656_119_796_026_5728;

fn acf_u64(state: &Vdf, key: &str) -> u64 {
    state
        .get(key)
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn account_id_from_steam64(id: &str) -> Option<String> {
    let n: u64 = id.parse().ok()?;
    if n >= STEAM64_BASE {
        Some((n - STEAM64_BASE).to_string())
    } else {
        Some(id.to_string())
    }
}

fn max_sync_unix(node: &Vdf) -> Option<i64> {
    let mut best: Option<i64> = None;
    walk_sync_unix(node, &mut best);
    best
}

fn walk_sync_unix(node: &Vdf, best: &mut Option<i64>) {
    for (k, v) in node.entries() {
        let key = k.to_ascii_lowercase();
        if matches!(key.as_str(), "time" | "synctime" | "remotetime" | "localtime") {
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    if n > 1_000_000 {
                        *best = Some(best.map_or(n, |b| b.max(n)));
                    }
                }
            }
        }
        walk_sync_unix(v, best);
    }
}

/// Reads Steam Cloud's last write for `app_id`, or `last_sync: null` when unknown.
#[tauri::command]
pub fn steam_cloud_status(app_id: String) -> SteamCloudStatus {
    let id = app_id.trim().trim_start_matches("steam::").to_string();
    let empty = SteamCloudStatus {
        app_id: id.clone(),
        last_sync: None,
    };
    let Some(steam) = steam_install_path() else {
        return empty;
    };
    let Some(user) = active_steam_id(&steam) else {
        return empty;
    };
    let account = account_id_from_steam64(&user).unwrap_or_else(|| user.clone());
    let paths = [
        steam.join("userdata").join(&account).join(&id).join("remotecache.vdf"),
        steam.join("userdata").join(&user).join(&id).join("remotecache.vdf"),
    ];
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        if let Some(ts) = max_sync_unix(&parse_vdf(&text)) {
            return SteamCloudStatus {
                app_id: id,
                last_sync: Some(ts),
            };
        }
    }
    empty
}

/// Opens a `steam://` URL through Steam's registered protocol handler.
///
/// `cmd start` eats `/` as switches. Passing the URI as a bare `steam.exe`
/// argument also fails: the client only treats it as a protocol when it is
/// preceded by `--` (the association is `steam.exe -- "%1"`).
fn spawn_uri(target: &str) -> Result<(), String> {
    if tauri_plugin_opener::open_url(target, None::<&str>).is_ok() {
        return Ok(());
    }
    if let Some(exe) = steam_install_path().map(|p| p.join("steam.exe")) {
        if exe.is_file() {
            let mut command = Command::new(&exe);
            command.arg("-silent").arg("--").arg(target);
            return command
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Steam could not be opened: {e}"));
        }
    }
    let mut command = Command::new("cmd");
    command.args(["/C", &format!("start \"\" \"{target}\"")]);
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

fn steam_action_url(app_id: &str, action: &str) -> Option<String> {
    match action {
        "launch" | "update" => Some(format!("steam://rungameid/{app_id}")),
        "install" => Some(format!("steam://install/{app_id}")),
        "uninstall" => Some(format!("steam://uninstall/{app_id}")),
        "validate" => Some(format!("steam://validate/{app_id}")),
        _ => None,
    }
}

#[tauri::command]
pub fn steam_game_action(app_id: String, action: String) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let Some(url) = steam_action_url(&app_id, &action) else {
        return Err("Unsupported Steam action".into());
    };
    spawn_uri(&url)
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
    /// Store category ids (1 multi-player, 2 single-player, 9 co-op, 36 online PvP ...).
    /// Ids are used instead of the labels because the labels are localized.
    #[serde(default)]
    pub categories: Vec<u32>,
    pub release_date: String,
    pub header_image: String,
    pub website: String,
    /// DLC app ids listed by the store (names would need one call each).
    pub dlc: Vec<String>,
    /// Requirement bullets (tags stripped, one per line).
    pub requirements_min: Vec<String>,
    pub requirements_rec: Vec<String>,
    /// Steam store field naming the third-party account / launcher, if any.
    #[serde(default)]
    pub ext_user_account_notice: String,
    /// Steam store DRM / anti-cheat blurb (Easy Anti-Cheat, BattlEye, …).
    #[serde(default)]
    pub drm_notice: String,
    /// Store Metacritic block (`score` + review URL) when Steam publishes one.
    #[serde(default)]
    pub metacritic_score: Option<u32>,
    #[serde(default)]
    pub metacritic_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CachedDetails {
    /// Cache shape version; older files are ignored after a parser fix.
    #[serde(default)]
    version: u32,
    fetched_at: u64,
    details: SteamGameDetails,
}

/// Bump whenever the parsed shape changes so stale entries refetch once.
const DETAILS_CACHE_VERSION: u32 = 6;

/* ---------- appinfo.vdf: the Steam client's own app metadata ---------- */

/// Magic of the 2023+ appinfo format (no string table) and the newer one.
const APPINFO_MAGIC_V40: u32 = 0x0756_4428;
const APPINFO_MAGIC_V41: u32 = 0x0756_4429;

fn read_u32_at(data: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(pos..pos + 4)?.try_into().ok()?))
}

/// The client string table: a u32 count followed by that many C strings.
fn parse_appinfo_strings(data: &[u8], offset: usize) -> Option<Vec<String>> {
    let count = read_u32_at(data, offset)? as usize;
    if count == 0 || count > 2_000_000 {
        return None;
    }
    let mut pos = offset + 4;
    let mut strings = Vec::with_capacity(count);
    for _ in 0..count {
        let start = pos;
        while pos < data.len() && data[pos] != 0 {
            pos += 1;
        }
        if pos >= data.len() {
            return None;
        }
        strings.push(String::from_utf8_lossy(&data[start..pos]).into_owned());
        pos += 1;
    }
    Some(strings)
}

/// Walks one appinfo KV blob and returns the first string value stored under
/// `wanted`. Keys are string-table indices in v41 and C strings in v40.
fn appinfo_find_string(data: &[u8], table: &Option<Vec<String>>, wanted: &str) -> Option<String> {
    struct Reader<'a> {
        data: &'a [u8],
        pos: usize,
        table: &'a Option<Vec<String>>,
    }
    impl Reader<'_> {
        fn read_key(&mut self) -> Option<String> {
            if let Some(table) = self.table {
                let index = read_u32_at(self.data, self.pos)? as usize;
                self.pos += 4;
                table.get(index).cloned()
            } else {
                self.read_cstring()
            }
        }

        fn read_cstring(&mut self) -> Option<String> {
            let start = self.pos;
            while self.pos < self.data.len() && self.data[self.pos] != 0 {
                self.pos += 1;
            }
            if self.pos >= self.data.len() {
                return None;
            }
            let text = String::from_utf8_lossy(&self.data[start..self.pos]).into_owned();
            self.pos += 1;
            Some(text)
        }

        fn find(&mut self, wanted: &str) -> Option<String> {
            loop {
                let tag = *self.data.get(self.pos)?;
                self.pos += 1;
                if tag == 8 {
                    return None;
                }
                let key = self.read_key()?;
                match tag {
                    0 => {
                        if let Some(found) = self.find(wanted) {
                            return Some(found);
                        }
                    }
                    1 => {
                        let value = self.read_cstring()?;
                        if key == wanted {
                            return Some(value);
                        }
                    }
                    2 | 3 | 4 | 6 => self.pos += 4,
                    5 => {
                        while self.pos + 1 < self.data.len()
                            && u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]) != 0
                        {
                            self.pos += 2;
                        }
                        self.pos += 2;
                    }
                    7 => self.pos += 8,
                    _ => return None,
                }
            }
        }
    }

    let mut reader = Reader { data, pos: 0, table };
    reader.find(wanted)
}

/// DLC app ids from the client's own `appcache/appinfo.vdf`.
///
/// The store API only lists DLCs that are still on sale, so delisted episode
/// packs (for example Life is Strange's) would otherwise disappear; the client
/// keeps them in `extended.listofdlc`.
pub fn parse_appinfo_dlc_ids(data: &[u8], app_id: &str) -> Vec<String> {
    let Some(magic) = read_u32_at(data, 0) else { return Vec::new() };
    let (table, mut pos, apps_end) = match magic {
        APPINFO_MAGIC_V41 => {
            let Some(offset) = data
                .get(8..16)
                .and_then(|b| b.try_into().ok())
                .map(u64::from_le_bytes)
                .map(|v| v as usize)
            else {
                return Vec::new();
            };
            if offset >= data.len() {
                return Vec::new();
            }
            (parse_appinfo_strings(data, offset), 16usize, offset)
        }
        APPINFO_MAGIC_V40 => (None, 8usize, data.len()),
        _ => return Vec::new(),
    };
    let Ok(target) = app_id.parse::<u32>() else { return Vec::new() };

    while pos + 68 <= apps_end {
        let Some(entry_id) = read_u32_at(data, pos) else { break };
        if entry_id == 0 {
            break;
        }
        let Some(size) = read_u32_at(data, pos + 4).map(|v| v as usize) else { break };
        if size < 60 || pos + 8 + size > data.len() {
            break;
        }
        if entry_id == target {
            let blob = &data[pos + 68..pos + 8 + size];
            let list = appinfo_find_string(blob, &table, "listofdlc").unwrap_or_default();
            return list
                .split(',')
                .map(|v| v.trim())
                .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
                .map(str::to_string)
                .collect();
        }
        pos += 8 + size;
    }
    Vec::new()
}

/// App ids whose client metadata says `releasestate` is `preloadonly`.
///
/// Those installs sit on disk before release. Steam sets `UpdateRequired` so
/// Play stays locked, but the client itself shows the game as up to date.
pub fn parse_appinfo_preload_ids(data: &[u8]) -> std::collections::HashSet<u32> {
    let Some(magic) = read_u32_at(data, 0) else {
        return std::collections::HashSet::new();
    };
    let (table, mut pos, apps_end) = match magic {
        APPINFO_MAGIC_V41 => {
            let Some(offset) = data
                .get(8..16)
                .and_then(|b| b.try_into().ok())
                .map(u64::from_le_bytes)
                .map(|v| v as usize)
            else {
                return std::collections::HashSet::new();
            };
            if offset >= data.len() {
                return std::collections::HashSet::new();
            }
            (parse_appinfo_strings(data, offset), 16usize, offset)
        }
        APPINFO_MAGIC_V40 => (None, 8usize, data.len()),
        _ => return std::collections::HashSet::new(),
    };

    let mut out = std::collections::HashSet::new();
    while pos + 68 <= apps_end {
        let Some(entry_id) = read_u32_at(data, pos) else { break };
        if entry_id == 0 {
            break;
        }
        let Some(size) = read_u32_at(data, pos + 4).map(|v| v as usize) else { break };
        if size < 60 || pos + 8 + size > data.len() {
            break;
        }
        let blob = &data[pos + 68..pos + 8 + size];
        if appinfo_find_string(blob, &table, "releasestate").as_deref() == Some("preloadonly") {
            out.insert(entry_id);
        }
        pos += 8 + size;
    }
    out
}

static PRELOAD_CACHE: std::sync::Mutex<
    Option<(Option<std::time::SystemTime>, std::collections::HashSet<u32>)>,
> = std::sync::Mutex::new(None);

/// Preload app ids from `appcache/appinfo.vdf`, reused until that file changes.
fn cached_preload_ids(steam: &Path) -> std::collections::HashSet<u32> {
    let path = steam.join("appcache").join("appinfo.vdf");
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut guard = PRELOAD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached_mtime, set)) = guard.as_ref() {
        if cached_mtime == &mtime {
            return set.clone();
        }
    }
    let set = std::fs::read(&path)
        .map(|data| parse_appinfo_preload_ids(&data))
        .unwrap_or_default();
    *guard = Some((mtime, set.clone()));
    set
}

/// Reads the client's DLC ids for one app from disk (empty when unavailable).
pub fn read_client_dlc_ids(steam: &Path, app_id: &str) -> Vec<String> {
    let Ok(data) = std::fs::read(steam.join("appcache").join("appinfo.vdf")) else {
        return Vec::new();
    };
    parse_appinfo_dlc_ids(&data, app_id)
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

/// `strip_html` turns `<strong>OS:</strong> Windows 10` into two lines; a
/// label-only line is joined back with the value that follows so the spec rows
/// keep their "OS: Windows 10" shape. A run of labels ("Minimum:", "OS:") is
/// left alone because the next label line also ends with a colon.
pub fn join_label_lines(lines: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        if let Some(prev) = out.last_mut() {
            if prev.ends_with(':') && !line.ends_with(':') {
                prev.push(' ');
                prev.push_str(&line);
                continue;
            }
        }
        out.push(line);
    }
    out
}

/// Turns one `appdetails` payload into the flat structure the game page uses.
pub fn parse_app_details(app_id: &str, data: &serde_json::Value) -> SteamGameDetails {
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
        categories: data
            .get("categories")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|c| c.get("id").and_then(|id| id.as_u64()))
                    .filter_map(|id| u32::try_from(id).ok())
                    .collect()
            })
            .unwrap_or_default(),
        release_date: data
            .get("release_date")
            .and_then(|v| v.get("date"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        header_image: data.get("header_image").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        website: data.get("website").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        dlc: data
            .get("dlc")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.to_string()).collect())
            .unwrap_or_default(),
        requirements_min: join_label_lines(html_lines(&requirements, "minimum")),
        requirements_rec: join_label_lines(html_lines(&requirements, "recommended")),
        ext_user_account_notice: data
            .get("ext_user_account_notice")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        drm_notice: data.get("drm_notice").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        metacritic_score: data
            .get("metacritic")
            .and_then(|m| m.get("score"))
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok()),
        metacritic_url: data
            .get("metacritic")
            .and_then(|m| m.get("url"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
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

/// Transport errors from `reqwest` print the request URL in their `Display`
/// output, and the achievement endpoints carry the Web API key inside that URL,
/// so every message handed to the UI drops the URL first.
fn transport_error(context: &str, error: reqwest::Error) -> String {
    format!("{context}: {}", error.without_url())
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
    force: Option<bool>,
) -> Result<SteamGameDetails, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let language = language.unwrap_or_else(|| "english".into());
    let cache = details_cache_path(&app, &app_id, &language);
    if force != Some(true) {
        if let Ok(text) = std::fs::read_to_string(&cache) {
            if let Ok(cached) = serde_json::from_str::<CachedDetails>(&text) {
                if cached.version == DETAILS_CACHE_VERSION
                    && now_secs().saturating_sub(cached.fetched_at) < DETAILS_TTL_SECS
                {
                    return Ok(cached.details);
                }
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
        .map_err(|e| transport_error("Steam store could not be reached", e))?
        .json()
        .await
        .map_err(|e| transport_error("Steam store answered with an unexpected payload", e))?;
    let entry = payload.get(&app_id).ok_or("Steam store has no record for this app")?;
    if entry.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Steam store has no record for this app".into());
    }
    let data = entry.get("data").ok_or("Steam store returned no data")?;
    let mut details = parse_app_details(&app_id, data);
    // The store only lists DLCs that are still on sale; the client's own cache
    // also keeps delisted packs (episodic releases from older games).
    if let Some(steam) = steam_install_path() {
        for dlc in read_client_dlc_ids(&steam, &app_id) {
            if !details.dlc.contains(&dlc) {
                details.dlc.push(dlc);
            }
        }
    }
    let cached = CachedDetails {
        version: DETAILS_CACHE_VERSION,
        fetched_at: now_secs(),
        details: details.clone(),
    };
    if let Ok(text) = serde_json::to_string(&cached) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(details)
}

/* ---------- Achievements (opt-in, needs a Steam Web API key) ---------- */

use crate::legendary::models::{
    AchievementItem, AchievementRarity, AchievementTier, GameAchievementSummary,
    GameAchievementsResponse,
};

/// Steam Web API key stored in settings.json (next to the SteamGridDB key).
#[tauri::command]
pub fn steam_get_api_key(app: tauri::AppHandle) -> Option<String> {
    crate::load_settings(&app).steam_api_key.filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn steam_set_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    let mut settings = crate::load_settings(&app);
    let trimmed = api_key.trim().to_string();
    settings.steam_api_key = if trimmed.is_empty() { None } else { Some(trimmed) };
    crate::save_settings(&app, &settings);
    Ok(())
}

/// SteamID64 + persona of the most recently used account (`loginusers.vdf`).
pub fn active_steam_user(steam: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(steam.join("config").join("loginusers.vdf")).ok()?;
    let root = parse_vdf(&text);
    let users = root.get("users")?;
    let mut fallback: Option<(String, String)> = None;
    for (id, node) in users.entries() {
        if !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let name = node
            .get("PersonaName")
            .and_then(Vdf::as_str)
            .unwrap_or("")
            .to_string();
        if fallback.is_none() {
            fallback = Some((id.clone(), name.clone()));
        }
        if node.get("MostRecent").and_then(Vdf::as_str) == Some("1") {
            return Some((id.clone(), name));
        }
    }
    fallback
}

/// SteamID64 of the most recently used account.
pub fn active_steam_id(steam: &Path) -> Option<String> {
    active_steam_user(steam).map(|(id, _)| id)
}

/// Unix seconds → `YYYY-MM-DD` (civil date, no date crate needed).
pub fn unix_date(seconds: i64) -> String {
    if seconds <= 0 {
        return String::new();
    }
    let days = seconds / 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

/// Tier by global unlock rate: Steam has no fixed tiers, so rarity stands in.
fn tier_for_percent(percent: f64) -> AchievementTier {
    let (name, hex) = if percent <= 5.0 {
        ("gold", "#d4a72c")
    } else if percent <= 25.0 {
        ("silver", "#a9adb7")
    } else {
        ("bronze", "#b07a4f")
    };
    AchievementTier {
        name: name.into(),
        hex_color: hex.into(),
        min: None,
        max: None,
    }
}

/// How long one game's achievement payload stays fresh.
const ACHIEVEMENTS_TTL_SECS: u64 = 60 * 60;

fn achievements_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("achievements");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/* ---------- Local achievement cache (offline, no Web API key) ---------- */

/// Valve binary KeyValues (`KeyValues::ReadAsBinary`): `[type][key]\0[payload]`,
/// where type 0 opens a subtree that ends with type 8. Scalars are normalized
/// to strings so the text-VDF helpers (`get` / `as_str` / `entries`) work as is.
fn parse_binary_vdf(data: &[u8]) -> Option<Vdf> {
    let mut pos = 0usize;
    Some(Vdf::Obj(read_binary_object(data, &mut pos)?))
}

fn read_binary_cstring(data: &[u8], pos: &mut usize) -> Option<String> {
    let start = *pos;
    while *pos < data.len() && data[*pos] != 0 {
        *pos += 1;
    }
    if *pos >= data.len() {
        return None;
    }
    let text = String::from_utf8_lossy(&data[start..*pos]).into_owned();
    *pos += 1;
    Some(text)
}

fn read_binary_object(data: &[u8], pos: &mut usize) -> Option<Vec<(String, Vdf)>> {
    let mut entries = Vec::new();
    loop {
        // A truncated file ends the current object instead of failing the parse.
        let Some(&tag) = data.get(*pos) else { return Some(entries) };
        *pos += 1;
        if tag == 8 {
            return Some(entries);
        }
        let key = read_binary_cstring(data, pos)?;
        let value = match tag {
            0 => Vdf::Obj(read_binary_object(data, pos)?),
            1 => Vdf::Str(read_binary_cstring(data, pos)?),
            2 => {
                let v = i32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            3 => {
                let v = f32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            4 | 6 => {
                let v = u32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            5 => {
                let mut out = String::new();
                while *pos + 1 < data.len() {
                    let unit = u16::from_le_bytes([data[*pos], data[*pos + 1]]);
                    *pos += 2;
                    if unit == 0 {
                        break;
                    }
                    out.push(char::from_u32(u32::from(unit)).unwrap_or('?'));
                }
                Vdf::Str(out)
            }
            7 => {
                let v = u64::from_le_bytes(data.get(*pos..*pos + 8)?.try_into().ok()?);
                *pos += 8;
                Vdf::Str(v.to_string())
            }
            _ => return None,
        };
        entries.push((key, value));
    }
}

/// 32-bit account id the Steam client uses in `userdata` and stats file names.
fn steam_account_id(steam: &Path) -> Option<u64> {
    let id64: u64 = active_steam_id(steam)?.parse().ok()?;
    Some(id64.saturating_sub(76_561_197_960_265_728))
}

fn stats_dir(steam: &Path) -> PathBuf {
    steam.join("appcache").join("stats")
}

/// Public global unlock rates (no Web API key needed) → `name` → percent.
fn parse_global_percentages(payload: &serde_json::Value) -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    let Some(items) = payload
        .get("achievementpercentages")
        .and_then(|p| p.get("achievements"))
        .and_then(|a| a.as_array())
    else {
        return out;
    };
    for entry in items {
        let Some(name) = entry.get("name").and_then(|v| v.as_str()) else { continue };
        // Valve returns the rate as a number or as a string, depending on the app.
        let percent = entry
            .get("percent")
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
        if let Some(percent) = percent {
            out.insert(name.to_string(), percent);
        }
    }
    out
}

/// Best-effort rarity for the local path: the endpoint is public but optional,
/// so a failure (offline, rate limit) simply leaves tiers unset.
async fn fetch_global_percentages(app_id: &str) -> std::collections::HashMap<String, f64> {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("efxlve-launcher")
        .build()
    else {
        return std::collections::HashMap::new();
    };
    let url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={app_id}"
    );
    let Ok(response) = client.get(&url).send().await else {
        return std::collections::HashMap::new();
    };
    let Ok(payload) = response.json::<serde_json::Value>().await else {
        return std::collections::HashMap::new();
    };
    parse_global_percentages(&payload)
}

/// Applies rarity/tier to an already-built achievement list.
fn apply_rarity(
    response: &mut GameAchievementsResponse,
    percentages: &std::collections::HashMap<String, f64>,
) {
    for item in response.achievements.iter_mut().chain(response.hidden.iter_mut()) {
        if let Some(percent) = percentages.get(&item.name) {
            item.tier = Some(tier_for_percent(*percent));
            item.rarity = Some(AchievementRarity { percent: Some(*percent) });
        }
    }
}

/// Achievement icon file name → the community CDN URL the Web API path also uses.
fn steam_icon_url(app_id: &str, file: &str) -> String {
    if file.is_empty() {
        String::new()
    } else {
        format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{app_id}/{file}")
    }
}

/// `group:bit` → unlock time, straight from the client's stats file.
fn read_unlock_times(steam: &Path, app_id: &str) -> std::collections::HashMap<String, i64> {
    let mut unlock_times = std::collections::HashMap::new();
    let Some(account) = steam_account_id(steam) else { return unlock_times };
    let user_file = stats_dir(steam).join(format!("UserGameStats_{account}_{app_id}.bin"));
    let Ok(bytes) = std::fs::read(user_file) else { return unlock_times };
    let Some(user) = parse_binary_vdf(&bytes) else { return unlock_times };
    if let Some(cache) = user.get("cache") {
        for (group_id, group) in cache.entries() {
            if let Some(times) = group.get("AchievementTimes") {
                for (bit_id, time) in times.entries() {
                    let value = time.as_str().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                    unlock_times.insert(format!("{group_id}:{bit_id}"), value);
                }
            }
        }
    }
    unlock_times
}

/// Achievements straight from the Steam client's own cache:
/// `appcache/stats/UserGameStatsSchema_<app>.bin` (definitions, icons) and
/// `UserGameStats_<account>_<app>.bin` (unlock times). Works offline, needs no
/// Web API key and no public profile; `None` when the client has no schema.
pub fn read_local_achievements(steam: &Path, app_id: &str) -> Option<GameAchievementsResponse> {
    let schema_bytes = std::fs::read(stats_dir(steam).join(format!("UserGameStatsSchema_{app_id}.bin"))).ok()?;
    let schema = parse_binary_vdf(&schema_bytes)?;
    let stats = schema.get(app_id)?.get("stats")?;
    let unlock_times = read_unlock_times(steam, app_id);

    let mut groups: Vec<&(String, Vdf)> = stats.entries().iter().collect();
    groups.sort_by_key(|(id, _)| id.parse::<u32>().unwrap_or(u32::MAX));

    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
    for (group_id, group) in groups {
        let Some(bits) = group.get("bits") else { continue };
        let mut bit_ids: Vec<&(String, Vdf)> = bits.entries().iter().collect();
        bit_ids.sort_by_key(|(id, _)| id.parse::<u32>().unwrap_or(u32::MAX));
        for (bit_id, bit) in bit_ids {
            let api_name = bit.get("name").and_then(Vdf::as_str).unwrap_or("").to_string();
            if api_name.is_empty() {
                continue;
            }
            let display = bit.get("display");
            let display_name = display
                .and_then(|d| d.get("name"))
                .and_then(|n| n.get("english"))
                .and_then(Vdf::as_str)
                .unwrap_or(&api_name)
                .to_string();
            let description = display
                .and_then(|d| d.get("desc"))
                .and_then(|n| n.get("english"))
                .and_then(Vdf::as_str)
                .unwrap_or("")
                .to_string();
            let hidden = display
                .and_then(|d| d.get("hidden"))
                .and_then(Vdf::as_str)
                .map(|v| v != "0")
                .unwrap_or(false);
            let unlock_time = unlock_times.get(&format!("{group_id}:{bit_id}")).copied().unwrap_or(0);
            let unlocked = unlock_time > 0;
            let icon = display.and_then(|d| d.get("icon")).and_then(Vdf::as_str).unwrap_or("");
            let icon_gray = display.and_then(|d| d.get("icon_gray")).and_then(Vdf::as_str).unwrap_or("");
            let file = if unlocked && !icon.is_empty() {
                icon
            } else if !icon_gray.is_empty() {
                icon_gray
            } else {
                icon
            };
            let item = AchievementItem {
                name: api_name,
                display_name,
                description,
                unlocked,
                progress: if unlocked { 1.0 } else { 0.0 },
                unlock_date: if unlocked { Some(unix_date(unlock_time)) } else { None },
                icon_link: steam_icon_url(app_id, file),
                hidden,
                // The local schema does not mark base/DLC groups; Steam
                // achievements are presented as one base-game set.
                is_base: true,
                ..Default::default()
            };
            if hidden {
                hidden_items.push(item.clone());
            }
            items.push(item);
        }
    }
    if items.is_empty() {
        return None;
    }

    let total = items.len() as u32;
    let unlocked = items.iter().filter(|i| i.unlocked).count() as u32;
    Some(GameAchievementsResponse {
        achievements: items,
        hidden: hidden_items,
        user_unlocked: unlocked,
        total_achievements: total,
        // Steam has no platinum trophy: a full set counts as the completed state.
        is_platinum: unlocked == total,
        supported: Some(true),
        ..Default::default()
    })
}

/// Unlocked/total counts for every game the client keeps stats for.
///
/// The total comes from the schema's bit definitions: the stats file's
/// `AchievementTimes` only holds entries that have a recorded time and can even
/// carry leftovers from a predecessor app (CS:GO bits under CS2), so using it
/// as the total made every game look 100% complete.
fn read_local_achievement_totals(steam: &Path) -> Vec<(String, u32, u32)> {
    let Some(account) = steam_account_id(steam) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(stats_dir(steam)) else { return Vec::new() };
    let prefix = format!("UserGameStats_{account}_");
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(&prefix) else { continue };
        let Some(app_id) = rest.strip_suffix(".bin") else { continue };
        if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(schema_bytes) =
            std::fs::read(stats_dir(steam).join(format!("UserGameStatsSchema_{app_id}.bin")))
        else {
            continue;
        };
        let Some(schema) = parse_binary_vdf(&schema_bytes) else { continue };
        let Some(stats) = schema.get(app_id).and_then(|app| app.get("stats")) else { continue };
        let unlock_times = read_unlock_times(steam, app_id);

        let (mut total, mut unlocked) = (0u32, 0u32);
        for (group_id, group) in stats.entries() {
            let Some(bits) = group.get("bits") else { continue };
            for (bit_id, _) in bits.entries() {
                total += 1;
                if unlock_times
                    .get(&format!("{group_id}:{bit_id}"))
                    .map(|time| *time > 0)
                    .unwrap_or(false)
                {
                    unlocked += 1;
                }
            }
        }
        if total > 0 {
            out.push((app_id.to_string(), unlocked, total));
        }
    }
    out
}

#[derive(Serialize, Deserialize)]
struct CachedAchievements {
    fetched_at: u64,
    response: GameAchievementsResponse,
}

/// Achievements for one Steam game. Read from the Steam client's own cache
/// first (offline, no key); the optional Web API key still answers for games
/// whose local schema is missing.
#[tauri::command]
pub async fn steam_get_achievements(
    app: tauri::AppHandle,
    app_id: String,
    force: Option<bool>,
) -> Result<GameAchievementsResponse, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let cache = achievements_cache_dir(&app).join(format!("{app_id}.json"));
    if force != Some(true) {
        if let Ok(text) = std::fs::read_to_string(&cache) {
            if let Ok(cached) = serde_json::from_str::<CachedAchievements>(&text) {
                if now_secs().saturating_sub(cached.fetched_at) < ACHIEVEMENTS_TTL_SECS {
                    return Ok(cached.response);
                }
            }
        }
    }

    // 1) The Steam client's own cache: instant, offline, no key, no rate limit.
    if let Some(mut response) = steam_install_path().and_then(|path| read_local_achievements(&path, &app_id)) {
        // Global unlock rates are public, so even the local path gets rarity.
        let percentages = fetch_global_percentages(&app_id).await;
        if !percentages.is_empty() {
            apply_rarity(&mut response, &percentages);
        }
        let cached = CachedAchievements { fetched_at: now_secs(), response: response.clone() };
        if let Ok(text) = serde_json::to_string(&cached) {
            let _ = std::fs::write(&cache, text);
        }
        return Ok(response);
    }

    // 2) Web API fallback (adds global rarity) when no local schema exists.
    let key = steam_get_api_key(app.clone()).ok_or("Steam has no local achievement data for this game and no Web API key is set")?;
    let steam_path = steam_install_path().ok_or("Steam is not installed")?;
    let steam_id = active_steam_id(&steam_path).ok_or("Steam account could not be read")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;

    // 1) Schema: display names, descriptions and icons.
    let schema_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key={key}&appid={app_id}&l=english"
    );
    let schema: serde_json::Value = client
        .get(&schema_url)
        .send()
        .await
        .map_err(|e| transport_error("Steam could not be reached", e))?
        .json()
        .await
        .map_err(|e| transport_error("Steam answered with an unexpected payload", e))?;
    let entries = schema
        .get("game")
        .and_then(|g| g.get("availableGameStats"))
        .and_then(|s| s.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return Ok(GameAchievementsResponse { supported: Some(false), ..Default::default() });
    }

    // 2) The player's own unlocks.
    let player_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key={key}&steamid={steam_id}&appid={app_id}&l=english"
    );
    let player: serde_json::Value = client
        .get(&player_url)
        .send()
        .await
        .map_err(|e| transport_error("Steam could not be reached", e))?
        .json()
        .await
        .map_err(|e| transport_error("Steam answered with an unexpected payload", e))?;
    let stats = player.get("playerstats");
    if stats.and_then(|s| s.get("success")).and_then(|v| v.as_bool()) != Some(true) {
        return Err("Steam does not share this profile's achievements; make the profile public".into());
    }
    let player_items = stats
        .and_then(|s| s.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    // 3) Global unlock rates for rarity (no key required, best effort).
    let percent_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={app_id}"
    );
    let percentages = match client.get(&percent_url).send().await {
        Ok(response) => response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    };
    let percent_items = percentages
        .get("achievementpercentages")
        .and_then(|p| p.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
    let mut unlocked = 0u32;
    for entry in &entries {
        let api_name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if api_name.is_empty() {
            continue;
        }
        let player_entry = player_items
            .iter()
            .find(|p| p.get("apiname").and_then(|v| v.as_str()) == Some(api_name));
        let achieved = player_entry
            .and_then(|p| p.get("achieved"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 1;
        let unlock_time = player_entry
            .and_then(|p| p.get("unlocktime"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if achieved {
            unlocked += 1;
        }
        let percent = percent_items
            .iter()
            .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(api_name))
            .and_then(|p| p.get("percent"))
            .and_then(|v| v.as_f64());
        let icon = entry.get("icon").and_then(|v| v.as_str()).unwrap_or("");
        let icon_gray = entry.get("icongray").and_then(|v| v.as_str()).unwrap_or("");
        let file = if achieved && !icon.is_empty() {
            icon
        } else if !icon_gray.is_empty() {
            icon_gray
        } else {
            icon
        };
        let hidden_flag = entry.get("hidden").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
        let item = AchievementItem {
            name: api_name.to_string(),
            display_name: entry
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or(api_name)
                .to_string(),
            description: entry
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            unlocked: achieved,
            progress: if achieved { 1.0 } else { 0.0 },
            unlock_date: if achieved { Some(unix_date(unlock_time)) } else { None },
            icon_link: if file.is_empty() {
                String::new()
            } else {
                format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{app_id}/{file}")
            },
            tier: percent.map(tier_for_percent),
            rarity: percent.map(|p| AchievementRarity { percent: Some(p) }),
            hidden: hidden_flag,
            // The Web API does not mark base/DLC groups either.
            is_base: true,
            ..Default::default()
        };
        if hidden_flag {
            hidden_items.push(item.clone());
        }
        items.push(item);
    }

    let total = items.len() as u32;
    let response = GameAchievementsResponse {
        achievements: items,
        hidden: hidden_items,
        user_unlocked: unlocked,
        total_achievements: total,
        // Steam has no platinum trophy: a full set counts as the completed state.
        is_platinum: total > 0 && unlocked == total,
        supported: Some(true),
        ..Default::default()
    };
    let cached = CachedAchievements { fetched_at: now_secs(), response: response.clone() };
    if let Ok(text) = serde_json::to_string(&cached) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(response)
}

/// How long the local totals scan stays fresh (parsing 150+ schemas is I/O heavy).
const ACH_TOTALS_TTL_SECS: u64 = 30 * 60;

#[derive(Serialize, Deserialize)]
struct CachedTotals {
    fetched_at: u64,
    totals: Vec<(String, u32, u32)>,
}

fn totals_cache_path(app: &tauri::AppHandle) -> PathBuf {
    achievements_cache_dir(app).with_file_name("achievement_totals.json")
}

/// Achievement summaries for the library covers: the per-game disk cache plus
/// the Steam client's own stats files (offline, no network, no key).
#[tauri::command]
pub fn steam_get_achievements_summary(
    app: tauri::AppHandle,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    let mut out = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(achievements_cache_dir(&app)) {
        for entry in entries.flatten() {
            let path = entry.path();
            let app_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(cached) = serde_json::from_str::<CachedAchievements>(&text) else { continue };
            let response = cached.response;
            if response.total_achievements == 0 {
                continue;
            }
            let summary = GameAchievementSummary {
                app_name: format!("steam::{app_id}"),
                user_unlocked: response.user_unlocked,
                total_achievements: response.total_achievements,
                is_platinum: response.is_platinum,
                supported: true,
                ..Default::default()
            };
            out.insert(format!("steam::{app_id}"), summary);
        }
    }

    // The client's stats files cover games whose page was never opened; the
    // cache above wins when both exist.
    let cache_path = totals_cache_path(&app);
    let cached = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|text| serde_json::from_str::<CachedTotals>(&text).ok())
        .filter(|cached| now_secs().saturating_sub(cached.fetched_at) < ACH_TOTALS_TTL_SECS);
    let totals = match cached {
        Some(cached) => cached.totals,
        None => match steam_install_path() {
            Some(steam) => {
                let totals = read_local_achievement_totals(&steam);
                let fresh = CachedTotals { fetched_at: now_secs(), totals: totals.clone() };
                if let Ok(text) = serde_json::to_string(&fresh) {
                    let _ = std::fs::write(&cache_path, text);
                }
                totals
            }
            None => Vec::new(),
        },
    };
    for (app_id, unlocked, total) in totals {
        let key = format!("steam::{app_id}");
        if out.contains_key(&key) {
            continue;
        }
        out.insert(
            key.clone(),
            GameAchievementSummary {
                app_name: key,
                user_unlocked: unlocked,
                total_achievements: total,
                is_platinum: unlocked == total,
                supported: true,
                ..Default::default()
            },
        );
    }
    out
}

use crate::legendary::screenshots::{
    file_to_data_url, format_bytes, get_file_local_datetime_str, GameScreenshotItem,
};

/// Screenshots taken by the Steam client for one app
/// (`userdata/<account>/760/remote/<app>/screenshots`).
///
/// Read-only: the files belong to the Steam client, so the gallery shows its
/// thumbnails and opens the originals, but never edits or deletes them.
#[tauri::command]
pub fn steam_get_game_screenshots(app_id: String) -> Vec<GameScreenshotItem> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Vec::new();
    }
    let Some(steam) = steam_install_path() else { return Vec::new() };
    let Some(account) = steam_account_id(&steam) else { return Vec::new() };
    let root = steam
        .join("userdata")
        .join(account.to_string())
        .join("760")
        .join("remote")
        .join(&app_id)
        .join("screenshots");
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };

    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        let lower = file_name.to_lowercase();
        if !(lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png")) {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(&path) else { continue };
        let timestamp = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let date_str = get_file_local_datetime_str(&path, &metadata, timestamp);
        // The gallery stays light with the client's thumbnail; the lightbox and
        // clipboard use the original.
        let thumb = root.join("thumbnails").join(&file_name);
        let preview = if thumb.is_file() { thumb } else { path.clone() };
        let Some(data_url) = file_to_data_url(&preview) else { continue };
        let full_data_url = if preview == path {
            String::new()
        } else {
            file_to_data_url(&path).unwrap_or_default()
        };
        let size_bytes = metadata.len();
        items.push(GameScreenshotItem {
            id: format!("{file_name}_{timestamp}"),
            file_path: path.to_string_lossy().to_string(),
            file_name,
            date_str,
            timestamp,
            size_bytes,
            size_str: format_bytes(size_bytes),
            data_url,
            full_data_url,
        });
    }
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    items
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
        assert_eq!(parse_app_manifest(APP_MANIFEST, Path::new("x")).unwrap().app_id, "620");
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
        assert!(!is_steam_library_noise("2322010", "Grand Theft Auto V Enhanced"));
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
        assert_eq!(strip_html(html), "Minimum:\nOS: Windows 10\nMemory: 8 GB & up");
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
                AchievementItem { name: "AC_1".into(), ..Default::default() },
                AchievementItem { name: "AC_2".into(), ..Default::default() },
                AchievementItem { name: "AC_3".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        apply_rarity(&mut response, &percentages);
        assert_eq!(response.achievements[0].tier.as_ref().map(|t| t.name.as_str()), Some("gold"));
        assert_eq!(response.achievements[1].tier.as_ref().map(|t| t.name.as_str()), Some("bronze"));
        assert_eq!(
            response.achievements[1].rarity.as_ref().and_then(|r| r.percent),
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
        assert_eq!(lines[2], "Processor: 4 hardware CPU threads - Intel® Core™ i5 750 or higher");
        assert_eq!(lines[3], "Additional Notes:");

        let data = serde_json::json!({
            "name": "Counter-Strike 2",
            "pc_requirements": { "minimum": html }
        });
        let details = parse_app_details("730", &data);
        assert!(details.requirements_min.iter().any(|l| l.starts_with("OS: ")));
        assert!(details.requirements_min.iter().any(|l| l.starts_with("Processor: ")));
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
                persona = format!("{id}:{}", node.get("PersonaName").and_then(Vdf::as_str).unwrap_or(""));
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
