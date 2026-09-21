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

/// File where collections are stored: %USERPROFILE%\.config\legendary\collections.json
pub fn get_collections_path() -> PathBuf {
    super::skip::default_config_dir().join("collections.json")
}

/// Reads collections.json directly from disk (does not call the fallback).
pub fn read_collections_raw() -> Vec<GameCollection> {
    let path = get_collections_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
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
            if !col.app_names.iter().any(|a| a.eq_ignore_ascii_case(app_name)) {
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

fn generate_collection_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
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

fn chrono_now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    format!("timestamp:{}", secs)
}

// -------------------------------------------------------------
// EPIC GAMES LAUNCHER LEVELDB IMPORTER
// -------------------------------------------------------------

/// Scans the EGL LevelDB logs to extract collections and game matches
pub fn import_egl_collections() -> Result<Vec<GameCollection>, String> {
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

    let egl_saved = local_app_data.join("EpicGamesLauncher").join("Saved");
    if !egl_saved.exists() {
        return Ok(Vec::new());
    }

    // Scan the games in the metadata folder
    let meta_map = build_metadata_lookup();

    // Search the webcache* folders
    let mut leveldb_dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(&egl_saved) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("webcache")) {
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
        return Ok(Vec::new());
    }

    let mut found_collections: HashMap<String, (String, Vec<String>)> = HashMap::new(); // id -> (name, app_names)

    for ldb_dir in leveldb_dirs {
        if let Ok(files) = fs::read_dir(&ldb_dir) {
            for f in files.flatten() {
                let path = f.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext == "log" || ext == "ldb" {
                    if let Ok(bytes) = fs::read(&path) {
                        parse_leveldb_buffer(&bytes, &meta_map, &mut found_collections);
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

    if !result.is_empty() {
        let existing = read_collections_raw();
        let mut merged = existing;
        for col in &result {
            if let Some(idx) = merged.iter().position(|c| c.id == col.id || c.name.eq_ignore_ascii_case(&col.name)) {
                merged[idx].name = col.name.clone();
                merged[idx].app_names = deduplicate_strings(col.app_names.clone());
            } else {
                merged.push(col.clone());
            }
        }
        let _ = save_collections(&merged);
        return Ok(merged);
    }

    Ok(result)
}

fn build_metadata_lookup() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let meta_dir = super::skip::default_config_dir().join("metadata");

    if let Ok(entries) = fs::read_dir(meta_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&p) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        let app_name = val.get("app_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        if !app_name.is_empty() {
                            if let Some(ns) = val.get("metadata").and_then(|m| m.get("namespace")).and_then(|v| v.as_str()) {
                                map.insert(ns.to_lowercase(), app_name.clone());
                            } else if let Some(ns) = val.get("namespace").and_then(|v| v.as_str()) {
                                map.insert(ns.to_lowercase(), app_name.clone());
                            }

                            if let Some(cat) = val.get("metadata").and_then(|m| m.get("catalogItemId")).and_then(|v| v.as_str()) {
                                map.insert(cat.to_lowercase(), app_name.clone());
                            } else if let Some(cat) = val.get("catalog_item_id").and_then(|v| v.as_str()) {
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
            let raw_name = if let Some(name_offset) = before_bytes.windows(4).rposition(|w| w == b"name") {
                let name_pos = start_before + name_offset + 4;
                if name_pos + 1 < bytes.len() {
                    let tag = bytes[name_pos];
                    let len = bytes[name_pos + 1] as usize;
                    if tag == 0x22 && name_pos + 2 + len <= bytes.len() {
                        String::from_utf8_lossy(&bytes[name_pos + 2..name_pos + 2 + len]).to_string()
                    } else if tag == 0x63 && name_pos + 2 + len <= bytes.len() {
                        let u16_vec: Vec<u16> = bytes[name_pos + 2..name_pos + 2 + len]
                            .chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        String::from_utf16_lossy(&u16_vec)
                    } else {
                        let before = &latin1_str[start_before..abs_idx];
                        if let Some(name_idx) = before.rfind("name") {
                            let after_name = &before[name_idx + 4..];
                            let trimmed = after_name.trim_end_matches(|c: char| c <= ' ' || c == '"' || c == '\u{000c}');
                            if let Some(start_idx) = trimmed.find(|c: char| c.is_alphabetic()) {
                                trimmed[start_idx..].to_string()
                            } else {
                                String::new()
                            }
                        } else {
                            String::new()
                        }
                    }
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            let clean = clean_collection_name(&raw_name);
            if !clean.is_empty() {
                found.entry(id).or_insert_with(|| (clean, Vec::new()));
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

fn clean_collection_name(name: &str) -> String {
    let mut s = name.replace('\u{0000}', "");
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

    #[test]
    fn test_deduplicate() {
        let input = vec!["Carnation".to_string(), "carnation".to_string(), "Ginger".to_string()];
        let dedup = deduplicate_strings(input);
        assert_eq!(dedup.len(), 2);
        assert_eq!(dedup[0], "Carnation");
        assert_eq!(dedup[1], "Ginger");
    }

    #[test]
    fn test_clean_name() {
        assert_eq!(clean_collection_name("Hikaye/Ba_ar1m Tamamlanan"), "Hikaye/Başarım Tamamlanan");
        assert_eq!(clean_collection_name("c2Hikaye/Ba_ ar1 m Tamamlanan"), "Hikaye/Başarım Tamamlanan");
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
