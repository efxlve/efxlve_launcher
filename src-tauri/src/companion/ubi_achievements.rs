//! Ubisoft Connect's local achievement cache.
//!
//! The client keeps two files on disk: the earned achievements in a protobuf
//! spool (`spool/<userId>/<appId>.spool`) and the localized schema with names
//! and icons in a zipped archive (`cache/achievements/<appId>_*`). Reading
//! them gives the game page the same progress the client shows, with no
//! service call and no account secret.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;

use crate::legendary::models::{AchievementItem, GameAchievementsResponse};

use super::proto::for_each_field;
use super::ubi_vault;

/// Reads one varint field from a protobuf message, descending into nested
/// length-delimited fields (the spool wraps every record once).
fn first_varint(data: &[u8], target: u32, depth: u32) -> Option<u64> {
    let found = std::cell::Cell::new(None);
    for_each_field(
        data,
        |_field, payload| {
            if found.get().is_none() && depth < 4 {
                if let Some(value) = first_varint(payload, target, depth + 1) {
                    found.set(Some(value));
                }
            }
        },
        |field, value| {
            if field == target && found.get().is_none() {
                found.set(Some(value));
            }
        },
    );
    found.get()
}

/// Earned achievement id → unix time in seconds. The spool time is normally
/// seconds, but a millisecond stamp is tolerated.
pub(crate) fn parse_spool(bytes: &[u8]) -> HashMap<u64, u64> {
    let mut out = HashMap::new();
    for_each_field(
        bytes,
        |field, payload| {
            if field != 1 {
                return;
            }
            let Some(id) = first_varint(payload, 1, 0) else {
                return;
            };
            let Some(earned) = first_varint(payload, 2, 0) else {
                return;
            };
            if id == 0 || earned == 0 {
                return;
            }
            let seconds = if earned > 10_000_000_000 { earned / 1000 } else { earned };
            // The earliest stamp wins when the client rewrites the record.
            out.entry(id)
                .and_modify(|cur| {
                    if seconds < *cur {
                        *cur = seconds;
                    }
                })
                .or_insert(seconds);
        },
        |_, _| {},
    );
    out
}

/* ---------- The zipped schema (names, descriptions, icons) ---------- */

struct ZipEntry {
    name: String,
    data: Vec<u8>,
}

fn read_u16(data: &[u8], pos: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(pos..pos + 2)?.try_into().ok()?))
}

fn read_u32(data: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(pos..pos + 4)?.try_into().ok()?))
}

fn find_eocd(data: &[u8]) -> Option<usize> {
    let min = data.len().saturating_sub(0xffff + 22);
    (min..=data.len().saturating_sub(22))
        .rev()
        .find(|&i| data.get(i..i + 4) == Some(&b"PK\x05\x06"[..]))
}

/// Reads the stored/inflated entries of a zip archive. The achievements cache
/// is small, so the whole file is decoded in one pass.
fn read_zip(data: &[u8]) -> Vec<ZipEntry> {
    let Some(eocd) = find_eocd(data) else {
        return Vec::new();
    };
    let (Some(size), Some(offset)) = (read_u32(data, eocd + 12), read_u32(data, eocd + 16)) else {
        return Vec::new();
    };
    let (size, offset) = (size as usize, offset as usize);
    let Some(end) = offset.checked_add(size) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    let mut pos = offset;
    while pos + 46 <= end && read_u32(data, pos) == Some(0x02014b50) {
        let (Some(method), Some(compressed), Some(uncompressed)) = (
            read_u16(data, pos + 10),
            read_u32(data, pos + 20),
            read_u32(data, pos + 24),
        ) else {
            break;
        };
        let (Some(name_len), Some(extra_len), Some(comment_len)) = (
            read_u16(data, pos + 28),
            read_u16(data, pos + 30),
            read_u16(data, pos + 32),
        ) else {
            break;
        };
        let Some(local) = read_u32(data, pos + 42) else {
            break;
        };
        let name_start = pos + 46;
        let Some(name_bytes) = data.get(name_start..name_start + name_len as usize) else {
            break;
        };
        let name = String::from_utf8_lossy(name_bytes).to_string();
        if read_u32(data, local as usize) == Some(0x04034b50) {
            let (Some(local_name), Some(local_extra)) = (
                read_u16(data, local as usize + 26),
                read_u16(data, local as usize + 28),
            ) else {
                break;
            };
            let start = local as usize + 30 + local_name as usize + local_extra as usize;
            if let Some(raw) = data.get(start..start + compressed as usize) {
                let decoded = match method {
                    0 => Some(raw.to_vec()),
                    8 => {
                        let mut out = Vec::with_capacity(uncompressed as usize);
                        let mut decoder = flate2::read::DeflateDecoder::new(raw);
                        decoder.read_to_end(&mut out).ok().map(|_| out)
                    }
                    _ => None,
                };
                if let Some(decoded) = decoded {
                    entries.push(ZipEntry { name, data: decoded });
                }
            }
        }
        pos += 46 + name_len as usize + extra_len as usize + comment_len as usize;
    }
    entries
}

/// Leading zeros are not part of an achievement id.
fn clean_id(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('0');
    if trimmed.is_empty() && !raw.trim().is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// One schema row: the id plus the localized name/description per locale key.
struct SchemaRow {
    id: String,
    names: HashMap<String, String>,
    descriptions: HashMap<String, String>,
    icon: Option<Vec<u8>>,
}

fn parse_loc_text(text: &str) -> HashMap<String, (String, String)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let raw_id = parts[0].trim();
        if raw_id.is_empty() || !raw_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let name = parts[1].trim().to_string();
        let description = parts[2..].join("\t").trim().to_string();
        out.insert(clean_id(raw_id), (name, description));
    }
    out
}

/// Parses the zipped schema into one row per achievement id.
fn parse_schema(data: &[u8]) -> Vec<SchemaRow> {
    let entries = read_zip(data);
    let mut names: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut descriptions: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut icons: HashMap<String, Vec<u8>> = HashMap::new();
    let mut ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in entries {
        let lower = entry.name.to_lowercase();
        if let Some(locale) = lower.strip_suffix("_loc.txt") {
            let locale = locale.to_string();
            for (id, (name, description)) in parse_loc_text(&String::from_utf8_lossy(&entry.data)) {
                if seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
                names.entry(id.clone()).or_default().insert(locale.clone(), name);
                descriptions.entry(id).or_default().insert(locale.clone(), description);
            }
        } else if lower.ends_with(".png") {
            let stem = &lower[..lower.len() - 4];
            if stem.chars().all(|c| c.is_ascii_digit()) {
                let id = clean_id(stem);
                if seen.insert(id.clone()) {
                    ids.push(id.clone());
                }
                icons.insert(id, entry.data);
            }
        }
    }

    ids.sort_by_key(|id| id.parse::<u64>().unwrap_or(u64::MAX));
    ids.into_iter()
        .map(|id| SchemaRow {
            names: names.remove(&id).unwrap_or_default(),
            descriptions: descriptions.remove(&id).unwrap_or_default(),
            icon: icons.remove(&id),
            id,
        })
        .collect()
}

/// UI language → Ubisoft locale entry (`<xx-XX>_loc.txt`), most specific first.
fn locale_candidates(language: &str) -> Vec<String> {
    let mut out: Vec<String> = match language {
        "tr" => vec!["tr-TR".into()],
        "en" => vec!["en-US".into()],
        "de" => vec!["de-DE".into()],
        "fr" => vec!["fr-FR".into()],
        "es" => vec!["es-ES".into()],
        "it" => vec!["it-IT".into()],
        "pt-BR" => vec!["pt-BR".into()],
        "ru" => vec!["ru-RU".into()],
        "pl" => vec!["pl-PL".into()],
        "ar" => vec!["ar-SA".into()],
        "ja" => vec!["ja-JP".into()],
        "ko" => vec!["ko-KR".into()],
        "th" => vec!["th-TH".into()],
        "zh-Hans" => vec!["zh-CN".into()],
        "zh-Hant" => vec!["zh-TW".into()],
        _ => Vec::new(),
    };
    out.push("en-US".into());
    out
}

fn pick_localized(map: &HashMap<String, String>, language: &str) -> String {
    for candidate in locale_candidates(language) {
        if let Some((_, value)) = map
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(&candidate))
        {
            return value.clone();
        }
    }
    map.values().next().cloned().unwrap_or_default()
}

/* ---------- Files on disk ---------- */

fn spool_root() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)?
        .join("Ubisoft Game Launcher")
        .join("spool");
    root.is_dir().then_some(root)
}

fn achievements_root() -> Option<PathBuf> {
    if let Some(program_data) = std::env::var_os("ProgramData") {
        let path = PathBuf::from(program_data)
            .join("Ubisoft")
            .join("Ubisoft Game Launcher")
            .join("cache")
            .join("achievements");
        if path.is_dir() {
            return Some(path);
        }
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)?
        .join("Ubisoft Game Launcher")
        .join("cache")
        .join("achievements");
    local.is_dir().then_some(local)
}

/// The client stores the archive as `<product id>_<spec>.zip`; an uninstalled
/// game only has its space id, so the configuration's `achievements:` spec is
/// the bridge between the two names.
pub(crate) fn normalize_spec(value: &str) -> String {
    let cleaned = value
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .replace('\\', "/");
    let base = cleaned.rsplit('/').next().unwrap_or("").to_string();
    let lower = base.to_lowercase();
    let lower = lower.strip_suffix(".zip").unwrap_or(&lower);
    match lower.split_once('_') {
        Some((head, rest)) if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) => {
            rest.to_string()
        }
        _ => lower.to_string(),
    }
}

fn file_matches_spec(file_name: &str, spec: &str) -> bool {
    if spec.is_empty() {
        return false;
    }
    let lower = file_name.to_lowercase();
    let base = lower.strip_suffix(".zip").unwrap_or(&lower);
    base == spec || base.ends_with(&format!("_{spec}"))
}

/// Newest schema archive: the product-id prefix first, then any file whose name
/// carries the configuration's achievement spec.
fn schema_path_for(root: &Path, app_id: &str, spec: &str) -> Option<PathBuf> {
    let prefix = format!("{app_id}_");
    let wanted = normalize_spec(spec);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut fallback: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_prefix = name.starts_with(&prefix);
        let is_spec = !is_prefix && file_matches_spec(&name, &wanted);
        if !is_prefix && !is_spec {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let slot = if is_prefix { &mut best } else { &mut fallback };
        if slot.as_ref().map_or(true, |(cur, _)| modified > *cur) {
            *slot = Some((modified, entry.path()));
        }
    }
    best.or(fallback).map(|(_, path)| path)
}

/// The linked account's own spool file, or the first one that exists.
fn spool_path(root: &Path, app_id: &str) -> Option<PathBuf> {
    let file = format!("{app_id}.spool");
    if let Some(user_id) = ubi_vault::load().map(|stored| stored.into_session().user_id) {
        if !user_id.is_empty() {
            let path = root.join(&user_id).join(&file);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path().join(&file);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Matches a configuration row by space id, then product id, then title.
fn config_match<'a>(
    rows: &'a [super::ubisoft::UbiRow],
    app_id: &str,
    title: &str,
) -> Option<&'a super::ubisoft::UbiRow> {
    rows.iter()
        .find(|r| !app_id.is_empty() && !r.space_id.is_empty() && r.space_id.eq_ignore_ascii_case(app_id))
        .or_else(|| rows.iter().find(|r| !app_id.is_empty() && r.launch_id.to_string() == app_id))
        .or_else(|| {
            let key = super::scan::slug(title);
            if key.is_empty() {
                return None;
            }
            rows.iter().find(|r| super::scan::slug(&r.name) == key)
        })
}

/// The achievements the local Ubisoft Connect client has for one game.
/// `id` is the library card id (client launch id, or the catalog space id for
/// an owned game the client has not installed). The configuration cache bridges
/// a space id to the archive spec and the product id.
pub(crate) fn achievements_for(app_id: &str, title: &str, language: &str) -> GameAchievementsResponse {
    // An Epic copy has no Ubisoft product id; the title alone can still find
    // the client's cache through the configuration index.
    if app_id.is_empty() && title.is_empty() {
        return GameAchievementsResponse::default();
    }
    let rows = super::ubisoft::config_rows();
    let entry = config_match(&rows, app_id, title);
    let spec = entry.map(|e| e.achievements.clone()).unwrap_or_default();
    let spool_id = entry
        .map(|e| e.launch_id)
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .or_else(|| {
            (!app_id.is_empty() && app_id.chars().all(|c| c.is_ascii_digit())).then(|| app_id.to_string())
        });

    let Some(root) = achievements_root() else {
        return GameAchievementsResponse::default();
    };
    let Some(schema) = schema_path_for(&root, app_id, &spec) else {
        return GameAchievementsResponse::default();
    };
    let Ok(bytes) = std::fs::read(&schema) else {
        return GameAchievementsResponse::default();
    };
    let rows = parse_schema(&bytes);
    if rows.is_empty() {
        return GameAchievementsResponse::default();
    }
    let earned = spool_id
        .and_then(|id| spool_root().and_then(|spool_root| spool_path(&spool_root, &id)))
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| parse_spool(&bytes))
        .unwrap_or_default();

    let mut achievements = Vec::with_capacity(rows.len());
    for row in rows {
        let unlocked_at = earned.get(&row.id.parse::<u64>().unwrap_or(u64::MAX)).copied();
        let unlocked = unlocked_at.is_some();
        let icon_link = row
            .icon
            .as_ref()
            .map(|icon| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(icon)
                )
            })
            .unwrap_or_default();
        achievements.push(AchievementItem {
            name: row.id.clone(),
            display_name: pick_localized(&row.names, language),
            description: pick_localized(&row.descriptions, language),
            xp: 0,
            unlocked,
            progress: if unlocked { 100.0 } else { 0.0 },
            unlock_date: unlocked_at
                .map(|seconds| crate::steam::unix_date(seconds as i64))
                .filter(|date| !date.is_empty()),
            icon_id: row.id,
            icon_link,
            tier: None,
            rarity: None,
            hidden: false,
            is_base: true,
        });
    }
    let total = achievements.len() as u32;
    let unlocked = achievements.iter().filter(|a| a.unlocked).count() as u32;
    GameAchievementsResponse {
        achievements,
        hidden: Vec::new(),
        user_unlocked: unlocked,
        user_xp: 0,
        total_achievements: total,
        total_xp: 0,
        is_platinum: false,
        supported: Some(total > 0),
        base_achievements: 0,
        base_unlocked: 0,
        base_xp: 0,
        base_user_xp: 0,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};
    fn spool_record(id: u64, earned: u64) -> Vec<u8> {
        let mut record = Vec::new();
        push_varint_field(&mut record, 1, id);
        push_varint_field(&mut record, 2, earned);
        let mut msg = Vec::new();
        push_bytes(&mut msg, 1, &record);
        msg
    }

    #[test]
    fn spool_records_keep_ids_and_earned_times() {
        let mut bytes = spool_record(7, 1_700_000_000);
        bytes.extend(spool_record(9, 0));
        bytes.extend(spool_record(11, 1_700_000_000_000));
        let earned = parse_spool(&bytes);
        assert_eq!(earned.get(&7), Some(&1_700_000_000));
        assert_eq!(earned.get(&9), None);
        assert_eq!(earned.get(&11), Some(&1_700_000_000));
    }

    /// Builds a stored (method 0) zip around the given entries.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in entries {
            let local = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&[0u8; 22]); // version, flags, method, time, crc, sizes
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra length
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&[0u8; 6]);
            central.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            central.extend_from_slice(&[0u8; 4]); // time + date
            central.extend_from_slice(&[0u8; 4]); // crc
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0u8; 8]); // extra, comment, disk, internal
            central.extend_from_slice(&[0u8; 4]); // external attributes
            central.extend_from_slice(&local.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&[0u8; 8]);
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&[0u8; 2]);
        out
    }

    #[test]
    fn schema_reads_localized_names_and_icons() {
        let loc = "1\tFirst Blood\tWin a race\n2\tSecond Wind\tFinish second\n";
        let zip = build_zip(&[
            ("en-US_loc.txt", loc.as_bytes()),
            ("tr-TR_loc.txt", "1\tİlk Kan\tBir yarış kazan\n".as_bytes()),
            ("1.png", b"PNG"),
        ]);
        let rows = parse_schema(&zip);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "1");
        assert_eq!(pick_localized(&rows[0].names, "tr"), "İlk Kan");
        assert_eq!(pick_localized(&rows[0].descriptions, "en"), "Win a race");
        assert_eq!(rows[0].icon.as_deref(), Some(b"PNG".as_slice()));
        assert_eq!(rows[1].id, "2");
        assert!(rows[1].icon.is_none());
    }

    #[test]
    fn leading_zero_ids_collapse() {
        assert_eq!(clean_id("007"), "7");
        assert_eq!(clean_id("0"), "0");
        assert_eq!(clean_id(""), "");
    }

    #[test]
    fn missing_archive_or_spool_yields_an_empty_response() {
        let data = achievements_for("", "", "en");
        assert_eq!(data.total_achievements, 0);
        assert!(data.achievements.is_empty());
    }

    #[test]
    fn specs_normalize_to_the_archive_tail() {
        assert_eq!(normalize_spec("ACOrigins"), "acorigins");
        assert_eq!(normalize_spec("./ACOrigins.zip"), "acorigins");
        assert_eq!(normalize_spec("3539_ACOrigins"), "acorigins");
        assert!(file_matches_spec("3539_ACOrigins.zip", "acorigins"));
        assert!(file_matches_spec("3539_acorigins.zip", "acorigins"));
        assert!(!file_matches_spec("3539_ACOdyssey.zip", "acorigins"));
        assert!(!file_matches_spec("3539_ACOrigins.zip", ""));
    }

    /// Live check for the bulk summary the profile reads. Needs a linked
    /// Ubisoft account with its client installed.
    /// Run: `cargo test live_ubisoft_achievement_summary -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_ubisoft_achievement_summary() {
        let mut found = 0;
        for game in super::super::library_games() {
            if game.store != "ubisoft" {
                continue;
            }
            let response = achievements_for(&game.id, &game.name, "en");
            if response.total_achievements == 0 {
                continue;
            }
            found += 1;
            println!(
                "{} | {}/{} unlocked | platinum {}",
                game.name, response.user_unlocked, response.total_achievements, response.is_platinum
            );
        }
        println!("ubisoft games with achievements: {found}");
    }
}
