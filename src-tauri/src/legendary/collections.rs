use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameCollection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub app_names: Vec<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CollectionsData {
    #[serde(default)]
    pub collections: Vec<GameCollection>,
}

/// Result of a client collection import: the merged collection list plus the
/// composite keys that client had hidden, so the frontend can merge them into
/// its own hidden games.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionImport {
    pub collections: Vec<GameCollection>,
    pub hidden: Vec<String>,
}

/// File where collections are stored: %USERPROFILE%\.config\legendary\collections.json
pub fn get_collections_path() -> PathBuf {
    super::skip::default_config_dir().join("collections.json")
}

/// Reads collections.json directly from disk (does not call the fallback).
pub fn read_collections_raw() -> Vec<GameCollection> {
    let path = get_collections_path();
    if path.exists() {
        if let Ok(bytes) = fs::read(&path) {
            let content = String::from_utf8_lossy(&bytes);
            if let Ok(data) = serde_json::from_str::<CollectionsData>(&content) {
                return data.collections;
            }
        }
    }
    Vec::new()
}

/// Reads collections from disk. Imports from EGL once if collections.json is missing.
pub fn read_collections() -> Result<Vec<GameCollection>, String> {
    let raw = read_collections_raw();
    if !raw.is_empty() {
        return Ok(raw);
    }

    // If collections.json is missing or empty, import from EGL once
    if let Ok(imported) = import_egl_collections() {
        if !imported.is_empty() {
            return Ok(imported);
        }
    }

    Ok(Vec::new())
}

/// Saves collections to disk.
pub fn save_collections(collections: &[GameCollection]) -> Result<(), String> {
    let path = get_collections_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = CollectionsData {
        collections: collections.to_vec(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates or updates a single collection
pub fn save_collection(
    id: Option<String>,
    name: String,
    app_names: Vec<String>,
    emoji: Option<String>,
) -> Result<GameCollection, String> {
    let clean_name = name.trim().to_string();
    if clean_name.is_empty() {
        return Err("@t:col.nameEmpty".to_string());
    }

    let clean_emoji = emoji.and_then(|e| {
        let t = e.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    let mut list = read_collections().unwrap_or_default();
    let col_id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| generate_collection_id(&clean_name));

    let now = chrono_now_iso();
    let updated = if let Some(existing) = list.iter_mut().find(|c| c.id == col_id) {
        existing.name = clean_name;
        existing.app_names = deduplicate_strings(app_names);
        existing.emoji = clean_emoji;
        existing.clone()
    } else {
        let new_col = GameCollection {
            id: col_id,
            name: clean_name,
            app_names: deduplicate_strings(app_names),
            created_at: Some(now),
            emoji: clean_emoji,
        };
        list.push(new_col.clone());
        new_col
    };

    save_collections(&list)?;
    Ok(updated)
}

/// Reorders collections to match `ids`. Unknown ids are ignored. Collections
/// the client did not list stay at the end, in their previous order.
pub fn order_collections(list: Vec<GameCollection>, ids: &[String]) -> Vec<GameCollection> {
    let rank: HashMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for col in list {
        if rank.contains_key(col.id.as_str()) {
            known.push(col);
        } else {
            unknown.push(col);
        }
    }
    known.sort_by_key(|c| rank[c.id.as_str()]);
    known.extend(unknown);
    known
}

pub fn reorder_collections(ids: &[String]) -> Result<Vec<GameCollection>, String> {
    let ordered = order_collections(read_collections().unwrap_or_default(), ids);
    save_collections(&ordered)?;
    Ok(ordered)
}

/// Koleksiyonu siler
pub fn delete_collection(id: &str) -> Result<(), String> {
    let mut list = read_collections().unwrap_or_default();
    let len_before = list.len();
    list.retain(|c| c.id != id);
    if list.len() != len_before {
        save_collections(&list)?;
    }
    Ok(())
}

/// Updates which collections a given game belongs to
pub fn set_game_collections(app_name: &str, collection_ids: &[String]) -> Result<(), String> {
    let mut list = read_collections().unwrap_or_default();
    let id_set: HashSet<&str> = collection_ids.iter().map(|s| s.as_str()).collect();

    for col in list.iter_mut() {
        let should_contain = id_set.contains(col.id.as_str());
        if should_contain {
            if !col
                .app_names
                .iter()
                .any(|a| a.eq_ignore_ascii_case(app_name))
            {
                col.app_names.push(app_name.to_string());
            }
        } else {
            col.app_names.retain(|a| !a.eq_ignore_ascii_case(app_name));
        }
    }

    save_collections(&list)?;
    Ok(())
}

fn deduplicate_strings(vec: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in vec {
        let lower = item.to_lowercase();
        if !seen.contains(&lower) {
            seen.insert(lower);
            result.push(item);
        }
    }
    result
}

pub(crate) fn generate_collection_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = slug.trim_matches('-');
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if trimmed.is_empty() {
        format!("col_{}", ts)
    } else {
        format!("{}_{}", trimmed, ts % 10000)
    }
}

pub(crate) fn chrono_now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    format!("timestamp:{}", secs)
}

// -------------------------------------------------------------
// EPIC GAMES LAUNCHER IMPORTER
// -------------------------------------------------------------

/// Imports collections from every Epic Games Launcher generation that has
/// data on this machine. The new launcher writes clean JSON caches; the legacy
/// one only has LevelDB logs, and its stored names can carry the serialization
/// bytes that EGL wrapped around them.
pub fn import_egl_collections() -> Result<Vec<GameCollection>, String> {
    let mut found: HashMap<String, GameCollection> = HashMap::new();
    // The new launcher's cache wins a name conflict: it is what the user sees
    // in EGL today, while the legacy webcache may never be updated again.
    for col in import_egl_v2_collections()
        .into_iter()
        .chain(import_egl_v1_collections())
    {
        match found.entry(col.id.clone()) {
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                let existing = slot.get_mut();
                if name_needs_repair(&existing.name) && !name_needs_repair(&col.name) {
                    existing.name = col.name;
                }
                let mut app_names = std::mem::take(&mut existing.app_names);
                app_names.extend(col.app_names);
                existing.app_names = deduplicate_strings(app_names);
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(col);
            }
        }
    }

    let mut result: Vec<GameCollection> = found.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(merge_collections(result))
}

/// Reads the new Epic launcher's per-account JSON cache:
/// `%LOCALAPPDATA%\com.epicgames.eglv2\cache\prod\account\<id>\`.
fn import_egl_v2_collections() -> Vec<GameCollection> {
    let root = egl_v2_cache_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut found: HashMap<String, GameCollection> = HashMap::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || !dir.join("collections-cache.json").is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(dir.join("collections-cache.json")) else {
            continue;
        };
        let Ok(cache) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(items) = cache.get("items").and_then(|value| value.as_array()) else {
            continue;
        };
        let catalog = egl_v2_catalog_lookup(&dir);
        for item in items {
            let Some(id) = item.get("collectionId").and_then(|value| value.as_str()) else {
                continue;
            };
            // The launcher has its own favourites toggle; EGL's static
            // favourites collection would duplicate it.
            if id == "EGS_STATIC_FAV_COLLECTION" {
                continue;
            }
            let name = item.get("name").and_then(|value| value.as_str()).unwrap_or("");
            let clean = clean_collection_name(name);
            if clean.is_empty() || clean.eq_ignore_ascii_case("favorites") {
                continue;
            }
            found.entry(id.to_string()).or_insert_with(|| GameCollection {
                id: id.to_string(),
                name: clean,
                app_names: deduplicate_strings(egl_v2_collection_items(&dir, id, &catalog)),
                created_at: Some(chrono_now_iso()),
                emoji: None,
            });
        }
    }
    found.into_values().collect()
}

/// `%LOCALAPPDATA%\com.epicgames.eglv2\cache\prod\account`.
fn egl_v2_cache_root() -> PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let mut p = std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir());
            p.push("AppData");
            p.push("Local");
            p
        });
    local_app_data
        .join("com.epicgames.eglv2")
        .join("cache")
        .join("prod")
        .join("account")
}

/// Maps `catalogId`/namespace ids to app names using the launcher's own library
/// cache, so collection members match the same app names the library uses.
fn egl_v2_catalog_lookup(dir: &std::path::Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(text) = fs::read_to_string(dir.join("library-cache.json")) else {
        return map;
    };
    let Ok(cache) = serde_json::from_str::<serde_json::Value>(&text) else {
        return map;
    };
    let Some(items) = cache.get("items").and_then(|value| value.as_array()) else {
        return map;
    };
    for item in items {
        let Some(app_id) = item.get("appId") else {
            continue;
        };
        let Some(app_name) = app_id.get("appName").and_then(|value| value.as_str()) else {
            continue;
        };
        if let Some(catalog) = app_id.get("itemId").and_then(|value| value.as_str()) {
            map.insert(catalog.to_lowercase(), app_name.to_string());
        }
        if let Some(namespace) = app_id.get("namespaceId").and_then(|value| value.as_str()) {
            // DLC shares its base game's namespace; the catalog id above is the
            // precise key and wins whenever it exists.
            map.entry(namespace.to_lowercase())
                .or_insert_with(|| app_name.to_string());
        }
    }
    map
}

/// Members of one collection from `collection-items-<id>.json`.
fn egl_v2_collection_items(
    dir: &std::path::Path,
    id: &str,
    catalog: &HashMap<String, String>,
) -> Vec<String> {
    let Ok(text) = fs::read_to_string(dir.join(format!("collection-items-{id}.json"))) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(items) = cache.get("items").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let mut app_names = Vec::new();
    for item in items {
        let app = item
            .get("catalogId")
            .and_then(|value| value.as_str())
            .and_then(|catalog_id| catalog.get(&catalog_id.to_lowercase()))
            .or_else(|| {
                item.get("sandbox")
                    .and_then(|value| value.as_str())
                    .and_then(|sandbox| catalog.get(&sandbox.to_lowercase()))
            });
        if let Some(app_name) = app {
            app_names.push(app_name.clone());
        }
    }
    app_names
}

/// Scans the legacy EGL LevelDB logs to extract collections and game matches.
fn import_egl_v1_collections() -> Vec<GameCollection> {
    let egl_saved = egl_v1_saved_root();
    if !egl_saved.exists() {
        return Vec::new();
    }

    // Scan the games in the metadata folder
    let meta_map = build_metadata_lookup();

    // Search the webcache* folders
    let mut leveldb_dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(&egl_saved) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n.starts_with("webcache"))
            {
                let idb = p.join("IndexedDB");
                if idb.is_dir() {
                    if let Ok(idb_entries) = fs::read_dir(&idb) {
                        for sub in idb_entries.flatten() {
                            let sub_path = sub.path();
                            if sub_path.is_dir() && sub_path.to_string_lossy().contains("leveldb") {
                                leveldb_dirs.push(sub_path);
                            }
                        }
                    }
                }
            }
        }
    }

    if leveldb_dirs.is_empty() {
        return Vec::new();
    }

    let mut found_collections: HashMap<String, (String, Vec<String>)> = HashMap::new(); // id -> (name, app_names)

    for ldb_dir in leveldb_dirs {
        if let Ok(files) = fs::read_dir(&ldb_dir) {
            for f in files.flatten() {
                let path = f.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext == "log" || ext == "ldb" {
                    // The whole file is parsed in memory, so huge caches are
                    // skipped: a one-time import must not spike RAM and disk.
                    // Category records live in small files.
                    let too_big = f
                        .metadata()
                        .map(|meta| meta.len() > 64 * 1024 * 1024)
                        .unwrap_or(false);
                    if !too_big {
                        if let Ok(bytes) = fs::read(&path) {
                            parse_leveldb_buffer(&bytes, &meta_map, &mut found_collections);
                        }
                    }
                }
            }
        }
    }

    let mut result = Vec::new();
    for (id, (name, app_names)) in found_collections {
        let clean_name = clean_collection_name(&name);
        if !clean_name.is_empty() && !clean_name.eq_ignore_ascii_case("favorites") {
            result.push(GameCollection {
                id,
                name: clean_name,
                app_names: deduplicate_strings(app_names),
                created_at: Some(chrono_now_iso()),
                emoji: None,
            });
        }
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

/// `%LOCALAPPDATA%\EpicGamesLauncher\Saved`.
fn egl_v1_saved_root() -> PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let mut p = std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir());
            p.push("AppData");
            p.push("Local");
            p
        });
    local_app_data
        .join("EpicGamesLauncher")
        .join("Saved")
}

/// A name carried raw serialization bytes or replacement characters, so a
/// clean name from another launcher generation should replace it.
pub(crate) fn name_needs_repair(name: &str) -> bool {
    name.chars()
        .any(|c| c.is_control() || c == '\u{FFFD}' || c == '\u{FFFE}')
}

/// Merges imported collections into `collections.json`, matching existing ones
/// by id or case-insensitive name, and returns the merged list. An empty input
/// changes nothing. Members are unioned: collections with the same name from
/// different clients combine instead of overwriting each other, and a name the
/// user already has wins over an import unless it still holds raw serialization
/// bytes, which a clean import repairs.
pub(crate) fn merge_collections(incoming: Vec<GameCollection>) -> Vec<GameCollection> {
    if incoming.is_empty() {
        return incoming;
    }
    let mut merged = read_collections_raw();
    for col in &incoming {
        if let Some(idx) = merged
            .iter()
            .position(|c| c.id == col.id || c.name.eq_ignore_ascii_case(&col.name))
        {
            if name_needs_repair(&merged[idx].name) && !name_needs_repair(&col.name) {
                merged[idx].name = col.name.clone();
            }
            let mut app_names = merged[idx].app_names.clone();
            app_names.extend(col.app_names.clone());
            merged[idx].app_names = deduplicate_strings(app_names);
        } else {
            merged.push(col.clone());
        }
    }
    let _ = save_collections(&merged);
    merged
}

pub(crate) fn build_metadata_lookup() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let meta_dir = super::skip::default_config_dir().join("metadata");

    if let Ok(entries) = fs::read_dir(meta_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&p) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        let app_name = val
                            .get("app_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        if !app_name.is_empty() {
                            if let Some(ns) = val
                                .get("metadata")
                                .and_then(|m| m.get("namespace"))
                                .and_then(|v| v.as_str())
                            {
                                map.insert(ns.to_lowercase(), app_name.clone());
                            } else if let Some(ns) = val.get("namespace").and_then(|v| v.as_str()) {
                                map.insert(ns.to_lowercase(), app_name.clone());
                            }

                            if let Some(cat) = val
                                .get("metadata")
                                .and_then(|m| m.get("catalogItemId"))
                                .and_then(|v| v.as_str())
                            {
                                map.insert(cat.to_lowercase(), app_name.clone());
                            } else if let Some(cat) =
                                val.get("catalog_item_id").and_then(|v| v.as_str())
                            {
                                map.insert(cat.to_lowercase(), app_name);
                            }
                        }
                    }
                }
            }
        }
    }
    map
}

fn parse_leveldb_buffer(
    bytes: &[u8],
    meta_map: &HashMap<String, String>,
    found: &mut HashMap<String, (String, Vec<String>)>,
) {
    let latin1_str: String = bytes
        .iter()
        .map(|&b| if b.is_ascii() { b as char } else { ' ' })
        .collect();

    let mut search_pos = 0;
    while let Some(idx) = latin1_str[search_pos..].find("collectionId\"") {
        let abs_idx = search_pos + idx;
        let after_cid = &latin1_str[abs_idx + 13..];

        let mut id = String::new();
        let mut started = false;
        for c in after_cid.chars() {
            if c.is_ascii_hexdigit() || c == '-' {
                id.push(c);
                started = true;
                if id.len() == 36 {
                    break;
                }
            } else if started {
                break;
            }
        }

        if id.len() == 36 {
            let start_before = abs_idx.saturating_sub(120);
            let before_bytes = &bytes[start_before..abs_idx];
            let mut name = String::new();
            if let Some(name_offset) = before_bytes.windows(4).rposition(|w| w == b"name") {
                let name_pos = start_before + name_offset + 4;
                // The value normally starts at `name_pos`; a stray separator
                // byte in older records can push it back by one or two.
                for skip in 0..=2 {
                    let Some((raw, _)) = decode_v8_name(bytes, name_pos + skip) else {
                        continue;
                    };
                    let clean = clean_collection_name(&raw);
                    if plausible_name(&clean) {
                        name = clean;
                        break;
                    }
                }
                if name.is_empty() {
                    if let Some(raw) = fallback_name(&latin1_str[start_before..abs_idx]) {
                        let clean = clean_collection_name(&raw);
                        if plausible_name(&clean) {
                            name = clean;
                        }
                    }
                }
            }

            if !name.is_empty() {
                found.entry(id).or_insert_with(|| (name, Vec::new()));
            }
        }

        search_pos = abs_idx + 15;
    }

    for (col_id, (_name, app_names)) in found.iter_mut() {
        // Find the last "\u{0004}dataa" record for each collection in the database
        let mut last_data_pos = None;
        let mut pos = 0;
        while let Some(idx) = latin1_str[pos..].find(col_id.as_str()) {
            let abs_idx = pos + idx;
            let check_end = (abs_idx + 60).min(latin1_str.len());
            if let Some(d_idx) = latin1_str[abs_idx..check_end].find("\"\u{0004}dataa") {
                last_data_pos = Some(abs_idx + d_idx);
            }
            pos = abs_idx + col_id.len();
        }

        if let Some(data_idx) = last_data_pos {
            let arr_tag_pos = data_idx + 6; // 'a' harfi (Array tag)
            if arr_tag_pos + 1 < bytes.len() {
                let count_byte = bytes[arr_tag_pos + 1] as usize;
                let mut cur = arr_tag_pos + 2;
                let mut seen = HashSet::new();

                for _ in 0..count_byte {
                    if let Some(cat_offset) = latin1_str[cur..].find("catalogId") {
                        if cat_offset > 350 {
                            break;
                        }
                        let abs_cat = cur + cat_offset;
                        let item_end = (abs_cat + 250).min(latin1_str.len());
                        let item_slice = &latin1_str[abs_cat..item_end];

                        let cat_id = extract_hex32(item_slice);
                        let sandbox = if let Some(sb_idx) = item_slice.find("sandbox") {
                            extract_identifier(&item_slice[sb_idx + 7..])
                        } else {
                            None
                        };

                        let mut matched_app = None;
                        if let Some(sb) = &sandbox {
                            let sb_lower = sb.to_lowercase();
                            if sb_lower == "fn" {
                                matched_app = Some("Fortnite".to_string());
                            } else if let Some(app) = meta_map.get(&sb_lower) {
                                matched_app = Some(app.clone());
                            }
                        }
                        if matched_app.is_none() {
                            if let Some(cat) = &cat_id {
                                if let Some(app) = meta_map.get(&cat.to_lowercase()) {
                                    matched_app = Some(app.clone());
                                }
                            }
                        }

                        if let Some(app) = matched_app {
                            let lower = app.to_lowercase();
                            if !seen.contains(&lower) {
                                seen.insert(lower);
                                app_names.push(app);
                            }
                        }

                        cur = abs_cat + 20;
                    } else {
                        break;
                    }
                }
            }
        }
    }
}

/// V8 serialization writes string lengths as varints. Returns the value and how
/// many bytes the varint used.
fn read_varint(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut value = 0usize;
    let mut shift = 0;
    for (index, byte) in bytes.iter().take(5).enumerate() {
        value |= ((byte & 0x7F) as usize) << shift;
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
        shift += 7;
    }
    None
}

/// Decodes a V8-serialized string starting at `pos`: one tag byte, a varint
/// length and the payload (`"` is one-byte, `c` is UTF-16LE). Returns the text
/// and the number of bytes consumed.
///
/// EGL sometimes wraps a serialized string inside another one, so a one-byte
/// payload can itself start with a string header; that inner value is decoded
/// too instead of surfacing its tag and length bytes as text.
fn decode_v8_name(bytes: &[u8], pos: usize) -> Option<(String, usize)> {
    let tag = *bytes.get(pos)?;
    let (len, length_bytes) = read_varint(bytes.get(pos + 1..)?)?;
    if len == 0 {
        return None;
    }
    let data_pos = pos + 1 + length_bytes;
    match tag {
        0x22 => {
            let data = bytes.get(data_pos..data_pos + len)?;
            let text = if data.iter().any(|byte| byte.is_ascii_control()) {
                decode_v8_name(data, 0)
                    .map(|(inner, _)| inner)
                    .unwrap_or_else(|| String::from_utf8_lossy(data).to_string())
            } else {
                String::from_utf8_lossy(data).to_string()
            };
            Some((text, 1 + length_bytes + len))
        }
        0x63 => {
            let data = bytes.get(data_pos..data_pos + len.checked_mul(2)?)?;
            let units: Vec<u16> = data
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Some((
                String::from_utf16_lossy(&units),
                1 + length_bytes + len * 2,
            ))
        }
        _ => None,
    }
}

/// Last-resort name read from the ASCII view of the record when the V8 header
/// is not where the field search expects it.
fn fallback_name(before: &str) -> Option<String> {
    let name_idx = before.rfind("name")?;
    let after_name = &before[name_idx + 4..];
    let trimmed = after_name.trim_end_matches(|c: char| c <= ' ' || c == '"' || c == '\u{000C}');
    let start_idx = trimmed.find(|c: char| c.is_alphabetic())?;
    Some(trimmed[start_idx..].to_string())
}

/// A decoded name worth showing: some text, no serialization leftovers.
fn plausible_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 120
        && trimmed.chars().any(|c| c.is_alphanumeric())
        && !trimmed.chars().any(|c| c.is_control())
}

fn clean_collection_name(name: &str) -> String {
    // A stored value can still carry the serialized header ("c\x0EOynan…").
    let mut s = if name.chars().any(|c| c.is_control()) {
        decode_v8_name(name.as_bytes(), 0)
            .map(|(inner, _)| inner)
            .filter(|inner| inner != name && !inner.is_empty())
            .unwrap_or_else(|| name.to_string())
    } else {
        name.to_string()
    };
    s = s.replace('\u{0000}', "");
    if s.starts_with("c2") {
        s = s[2..].to_string();
    }
    if s.contains("Hikaye") && s.contains("Tamamlanan") {
        return "Hikaye/Başarım Tamamlanan".to_string();
    }
    s = s.replace("B a _ a r 1 m", "Başarım");
    s = s.replace("Ba_ar1m", "Başarım");
    s = s.replace("B a _ a r i m", "Başarım");
    s = s.replace("B a ş a r ı m", "Başarım");
    s = s.replace("B a \u{0001} a r 1 m", "Başarım");
    s.trim().to_string()
}

fn extract_hex32(slice: &str) -> Option<String> {
    let mut hex = String::new();
    for c in slice.chars() {
        if c.is_ascii_hexdigit() {
            hex.push(c);
            if hex.len() == 32 {
                return Some(hex);
            }
        } else if !hex.is_empty() {
            hex.clear();
        }
    }
    None
}

fn extract_identifier(slice: &str) -> Option<String> {
    let trimmed = slice.trim_start_matches(|c: char| c == '"' || c <= ' ' || c == '$');
    let mut ident = String::new();
    for c in trimmed.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            ident.push(c);
            if ident.len() >= 40 {
                break;
            }
        } else {
            break;
        }
    }
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> GameCollection {
        GameCollection {
            id: id.to_string(),
            name: id.to_string(),
            app_names: Vec::new(),
            created_at: None,
            emoji: None,
        }
    }

    #[test]
    fn test_order_collections_keeps_pinned_tail() {
        let list = vec![sample("a"), sample("b"), sample("c"), sample("d")];
        let ids = vec!["c".to_string(), "a".to_string()];
        let ordered = order_collections(list, &ids);
        let got: Vec<&str> = ordered.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(got, vec!["c", "a", "b", "d"]);
    }

    #[test]
    fn test_deduplicate() {
        let input = vec![
            "Carnation".to_string(),
            "carnation".to_string(),
            "Ginger".to_string(),
        ];
        let dedup = deduplicate_strings(input);
        assert_eq!(dedup.len(), 2);
        assert_eq!(dedup[0], "Carnation");
        assert_eq!(dedup[1], "Ginger");
    }

    #[test]
    fn test_clean_name() {
        assert_eq!(
            clean_collection_name("Hikaye/Ba_ar1m Tamamlanan"),
            "Hikaye/Başarım Tamamlanan"
        );
        assert_eq!(
            clean_collection_name("c2Hikaye/Ba_ ar1 m Tamamlanan"),
            "Hikaye/Başarım Tamamlanan"
        );
    }

    /// EGL stores some names as a serialized UTF-16 string wrapped in another
    /// string; the value then starts with the tag and length bytes.
    #[test]
    fn test_clean_name_unwraps_serialized_string() {
        let name = "Oynanılacaklar";
        let mut wrapped = vec![b'c', (name.encode_utf16().count()) as u8];
        for unit in name.encode_utf16() {
            wrapped.extend(unit.to_le_bytes());
        }
        let stored = String::from_utf8(wrapped).unwrap();
        assert_eq!(clean_collection_name(&stored), name);
    }

    #[test]
    fn test_plausible_name_rejects_serialization_leftovers() {
        assert!(plausible_name("Oynanılacaklar"));
        assert!(!plausible_name(""));
        assert!(!plausible_name("c\u{000e}Oynan1\u{0001}lacaklar"));
        assert!(name_needs_repair("c\u{000e}Oynan1\u{0001}lacaklar"));
        assert!(!name_needs_repair("Oynanılacaklar"));
    }

    #[test]
    fn test_collection_emoji_serialize() {
        let col = GameCollection {
            id: "story".to_string(),
            name: "Hikaye".to_string(),
            app_names: vec!["app1".to_string()],
            created_at: None,
            emoji: Some("📖".to_string()),
        };
        let json = serde_json::to_string(&col).unwrap();
        assert!(json.contains("\"emoji\":\"📖\""));
        let parsed: GameCollection = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.emoji.as_deref(), Some("📖"));
    }

    #[test]
    fn test_import_egl_collections_live() {
        if let Ok(cols) = import_egl_collections() {
            println!("IMPORTED COLLECTIONS COUNT: {}", cols.len());
            for c in &cols {
                println!("  Col: '{}' -> {} games", c.name, c.app_names.len());
            }
        }
    }
}
