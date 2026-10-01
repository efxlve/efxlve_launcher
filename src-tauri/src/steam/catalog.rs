//! Store page details, the client `appinfo.vdf` cache, and the Web API key.
//!
//! Store text is cached on disk for six hours. The language and app id are
//! checked before they become a cache file name.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::runtime::steam_install_path;

/* ---------- Store details (network, cached on disk) ---------- */

/// How long a store description stays fresh.
pub(super) const DETAILS_TTL_SECS: u64 = 6 * 60 * 60;

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
pub(super) struct CachedDetails {
    /// Cache shape version; older files are ignored after a parser fix.
    #[serde(default)]
    version: u32,
    fetched_at: u64,
    details: SteamGameDetails,
}

/// Bump whenever the parsed shape changes so stale entries refetch once.
pub(super) const DETAILS_CACHE_VERSION: u32 = 6;

/* ---------- appinfo.vdf: the Steam client's own app metadata ---------- */

/// Magic of the 2023+ appinfo format (no string table) and the newer one.
pub(super) const APPINFO_MAGIC_V40: u32 = 0x0756_4428;
pub(super) const APPINFO_MAGIC_V41: u32 = 0x0756_4429;

pub(super) fn read_u32_at(data: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(pos..pos + 4)?.try_into().ok()?))
}

/// The client string table: a u32 count followed by that many C strings.
pub(super) fn parse_appinfo_strings(data: &[u8], offset: usize) -> Option<Vec<String>> {
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
pub(super) fn appinfo_find_string(
    data: &[u8],
    table: &Option<Vec<String>>,
    wanted: &str,
) -> Option<String> {
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
                            && u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]])
                                != 0
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

    let mut reader = Reader {
        data,
        pos: 0,
        table,
    };
    reader.find(wanted)
}

/// DLC app ids from the client's own `appcache/appinfo.vdf`.
///
/// The store API only lists DLCs that are still on sale, so delisted episode
/// packs (for example Life is Strange's) would otherwise disappear; the client
/// keeps them in `extended.listofdlc`.
pub fn parse_appinfo_dlc_ids(data: &[u8], app_id: &str) -> Vec<String> {
    let Some(magic) = read_u32_at(data, 0) else {
        return Vec::new();
    };
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
    let Ok(target) = app_id.parse::<u32>() else {
        return Vec::new();
    };

    while pos + 68 <= apps_end {
        let Some(entry_id) = read_u32_at(data, pos) else {
            break;
        };
        if entry_id == 0 {
            break;
        }
        let Some(size) = read_u32_at(data, pos + 4).map(|v| v as usize) else {
            break;
        };
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
        let Some(entry_id) = read_u32_at(data, pos) else {
            break;
        };
        if entry_id == 0 {
            break;
        }
        let Some(size) = read_u32_at(data, pos + 4).map(|v| v as usize) else {
            break;
        };
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

pub(super) static PRELOAD_CACHE: std::sync::Mutex<
    Option<(
        Option<std::time::SystemTime>,
        std::collections::HashSet<u32>,
    )>,
> = std::sync::Mutex::new(None);

/// Preload app ids from `appcache/appinfo.vdf`, reused until that file changes.
pub(super) fn cached_preload_ids(steam: &Path) -> std::collections::HashSet<u32> {
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

pub(super) fn html_lines(value: &serde_json::Value, key: &str) -> Vec<String> {
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

pub(super) fn string_list(value: &serde_json::Value, key: &str) -> Vec<String> {
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
    let requirements = data
        .get("pc_requirements")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    SteamGameDetails {
        app_id: app_id.to_string(),
        name: data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
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
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        publishers: data
            .get("publishers")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
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
        header_image: data
            .get("header_image")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        website: data
            .get("website")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
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
        drm_notice: data
            .get("drm_notice")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
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

/// Steam store language codes are a single alphanumeric token (`english`, `schinese`).
/// Separators would escape the details cache directory.
pub(super) fn safe_store_language(language: String) -> Result<String, String> {
    if (1..=32).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(language)
    } else {
        Err("Invalid Steam language".into())
    }
}

pub(super) fn details_cache_path(app: &tauri::AppHandle, app_id: &str, language: &str) -> PathBuf {
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

pub(super) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Transport errors from `reqwest` print the request URL in their `Display`
/// output, and the achievement endpoints carry the Web API key inside that URL,
/// so every message handed to the UI drops the URL first.
pub(super) fn transport_error(context: &str, error: reqwest::Error) -> String {
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
    let language = safe_store_language(language.unwrap_or_else(|| "english".into()))?;
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
    let entry = payload
        .get(&app_id)
        .ok_or("Steam store has no record for this app")?;
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

/// Steam Web API key stored in settings.json (next to the SteamGridDB key).
#[tauri::command]
pub fn steam_get_api_key(app: tauri::AppHandle) -> Option<String> {
    crate::load_settings(&app)
        .steam_api_key
        .filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn steam_set_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    let mut settings = crate::load_settings(&app);
    let trimmed = api_key.trim().to_string();
    settings.steam_api_key = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    crate::save_settings(&app, &settings);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::playtime::read_playtimes;
    use super::super::runtime::steam_install_path;


    #[test]
    fn store_language_rejects_path_separators() {
        assert!(safe_store_language("english".into()).is_ok());
        assert!(safe_store_language("schinese".into()).is_ok());
        assert!(safe_store_language("../x".into()).is_err());
        assert!(safe_store_language(r"..\x".into()).is_err());
        assert!(safe_store_language(String::new()).is_err());
        assert!(safe_store_language("en glish".into()).is_err());
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
}
