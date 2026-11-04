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
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use base64::Engine;
use serde::{Deserialize, Serialize};

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
/// The icon is encoded once when the archive is parsed; the 30 s session poll
/// only clones the ready data URL.
struct SchemaRow {
    id: String,
    names: HashMap<String, String>,
    descriptions: HashMap<String, String>,
    icon: Option<String>,
}

/// Parsed schema keyed by file identity. The archive is a zip with every icon
/// inside it; parsing and base64-encoding it on every session tick was the
/// expensive part, not the tiny spool read.
struct SchemaCacheEntry {
    len: u64,
    modified: Option<SystemTime>,
    rows: Arc<Vec<SchemaRow>>,
}

static SCHEMA_CACHE: Mutex<Option<HashMap<PathBuf, SchemaCacheEntry>>> = Mutex::new(None);
/// Keep the running game and one browsed game; clearing beyond that bounds the
/// decoded icon memory on a low-end machine.
const SCHEMA_CACHE_LIMIT: usize = 2;

fn cached_schema(path: &Path) -> Option<Arc<Vec<SchemaRow>>> {
    let meta = std::fs::metadata(path).ok()?;
    let len = meta.len();
    let modified = meta.modified().ok();
    let cache = SCHEMA_CACHE.lock().ok()?;
    let entry = cache.as_ref()?.get(path)?;
    (entry.len == len && entry.modified == modified).then(|| entry.rows.clone())
}

fn load_schema(path: &Path) -> Option<Arc<Vec<SchemaRow>>> {
    if let Some(rows) = cached_schema(path) {
        return Some(rows);
    }
    let bytes = std::fs::read(path).ok()?;
    let rows = Arc::new(parse_schema(&bytes));
    let meta = std::fs::metadata(path).ok();
    if let Ok(mut cache) = SCHEMA_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        if map.len() >= SCHEMA_CACHE_LIMIT {
            map.clear();
        }
        map.insert(
            path.to_path_buf(),
            SchemaCacheEntry {
                len: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| m.modified().ok()),
                rows: rows.clone(),
            },
        );
    }
    Some(rows)
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
    let mut icons: HashMap<String, String> = HashMap::new();
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
                icons.insert(
                    id,
                    format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(entry.data)
                    ),
                );
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
        "hi" => vec!["hi-IN".into()],
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

fn achievements_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let app_cache = super::accounts::data_dir().join("ubi-achievements");
    if app_cache.is_dir() {
        roots.push(app_cache);
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        let path = PathBuf::from(program_data)
            .join("Ubisoft")
            .join("Ubisoft Game Launcher")
            .join("cache")
            .join("achievements");
        if path.is_dir() {
            roots.push(path);
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let path = PathBuf::from(local)
            .join("Ubisoft Game Launcher")
            .join("cache")
            .join("achievements");
        if path.is_dir() {
            roots.push(path);
        }
    }
    roots
}

const ACHIEVEMENT_ASSET_BASE: &str =
    "https://static3.cdn.ubi.com/orbit/uplay_launcher_3_0/assets";

/// The parts of a product configuration the achievement cache needs. The
/// client's local `configurations.vdat` is encrypted on current builds, so the
/// launcher records the same fields from the ownership service instead.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AchievementMeta {
    #[serde(default)]
    pub product_id: u32,
    #[serde(default)]
    pub uplay_id: u32,
    #[serde(default)]
    pub space_id: String,
    pub name: String,
    #[serde(default)]
    pub achievements: String,
}

fn specs_path() -> PathBuf {
    super::accounts::data_dir().join("ubi-achievement-specs.json")
}

pub(crate) fn load_specs() -> Vec<AchievementMeta> {
    let Ok(text) = std::fs::read_to_string(specs_path()) else {
        return Vec::new();
    };
    let mut rows: Vec<AchievementMeta> = serde_json::from_str(&text).unwrap_or_default();
    rows.retain(|row| !row.name.trim().is_empty());
    rows
}

fn same_product(left: &AchievementMeta, right: &AchievementMeta) -> bool {
    (left.product_id != 0 && left.product_id == right.product_id)
        || (left.uplay_id != 0 && left.uplay_id == right.uplay_id)
}

fn same_space(left: &AchievementMeta, right: &AchievementMeta) -> bool {
    !left.space_id.is_empty() && left.space_id.eq_ignore_ascii_case(&right.space_id)
}

fn same_name(left: &AchievementMeta, right: &AchievementMeta) -> bool {
    let key = super::scan::slug(&right.name);
    !key.is_empty() && super::scan::slug(&left.name) == key
}

/// Keep the ownership-service metadata between sessions. A row is merged by
/// product/uplay id, then space id, then title, so a later import refreshes the
/// spec without duplicating the game.
pub(crate) fn record_specs(rows: &[AchievementMeta]) {
    if rows.is_empty() {
        return;
    }
    let mut all = load_specs();
    for row in rows.iter().filter(|row| !row.name.trim().is_empty()) {
        let existing = all
            .iter_mut()
            .find(|cur| same_product(cur, row) || same_space(cur, row) || same_name(cur, row));
        match existing {
            Some(cur) => {
                if row.product_id != 0 {
                    cur.product_id = row.product_id;
                }
                if row.uplay_id != 0 {
                    cur.uplay_id = row.uplay_id;
                }
                if !row.space_id.is_empty() {
                    cur.space_id = row.space_id.clone();
                }
                if !row.name.is_empty() {
                    cur.name = row.name.clone();
                }
                if !row.achievements.is_empty() {
                    cur.achievements = row.achievements.clone();
                }
            }
            None => all.push(row.clone()),
        }
    }
    all.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    let path = specs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&all) {
        let _ = std::fs::write(path, text);
    }
}

fn meta_for(app_id: &str, title: &str) -> Option<AchievementMeta> {
    let app_id = app_id.trim();
    let title_key = super::scan::slug(title);
    load_specs().into_iter().find(|row| {
        (!app_id.is_empty()
            && (row.space_id.eq_ignore_ascii_case(app_id)
                || row.product_id.to_string() == app_id
                || row.uplay_id.to_string() == app_id))
            || (!title_key.is_empty() && super::scan::slug(&row.name) == title_key)
    })
}

/// The archive URL the Connect client logs for an `achievements:` spec. Only
/// the Ubisoft asset host is accepted, so a malformed configuration can never
/// turn into an arbitrary network request.
fn achievement_asset_url(spec: &str) -> Option<String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        let base = trimmed.split('?').next().unwrap_or(trimmed);
        return base
            .starts_with(ACHIEVEMENT_ASSET_BASE)
            .then(|| base.to_string());
    }
    let spec = normalize_spec(trimmed);
    if spec.is_empty()
        || !spec
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return None;
    }
    Some(format!("{ACHIEVEMENT_ASSET_BASE}/{spec}"))
}

fn schema_cache_path(meta: &AchievementMeta) -> Option<PathBuf> {
    let spec = normalize_spec(&meta.achievements);
    if spec.is_empty() {
        return None;
    }
    let id = if meta.product_id != 0 {
        meta.product_id
    } else if meta.uplay_id != 0 {
        meta.uplay_id
    } else {
        return None;
    };
    Some(
        super::accounts::data_dir()
            .join("ubi-achievements")
            .join(format!("{id}_{spec}")),
    )
}

/// Fetch one achievement archive from Ubisoft's asset CDN and store it in the
/// same `<product>_<spec>` naming the official client uses. The parse is the
/// proof the download is a schema and not an HTML error page.
pub(crate) async fn download_schema(meta: &AchievementMeta) -> Result<PathBuf, String> {
    let url = achievement_asset_url(&meta.achievements).ok_or_else(|| {
        format!("no achievement asset URL for {}", meta.name)
    })?;
    let path = schema_cache_path(meta)
        .ok_or_else(|| format!("no achievement cache name for {}", meta.name))?;
    if let Ok(bytes) = std::fs::read(&path) {
        if !parse_schema(&bytes).is_empty() {
            return Ok(path);
        }
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; WOW64) ConnectPC")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("building the achievement client: {error}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("downloading the achievement schema: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("reading the achievement schema: {error}"))?;
    if !status.is_success() {
        return Err(format!("Ubisoft returned {status} for the achievement schema"));
    }
    if !bytes.starts_with(b"PK\x03\x04") || parse_schema(&bytes).is_empty() {
        return Err("Ubisoft returned an invalid achievement schema".to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    let part = path.with_extension("part");
    std::fs::write(&part, &bytes)
        .map_err(|error| format!("writing {}: {error}", part.display()))?;
    std::fs::rename(&part, &path)
        .map_err(|error| format!("renaming {}: {error}", path.display()))?;
    Ok(path)
}

/// One failed metadata refresh per five minutes is enough; an expired session
/// must not make every game page wait on Demux again.
static METADATA_ATTEMPT: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn metadata_refresh_allowed() -> bool {
    let Ok(mut slot) = METADATA_ATTEMPT.lock() else {
        return false;
    };
    let allowed = slot
        .as_ref()
        .map(|at| at.elapsed() >= std::time::Duration::from_secs(300))
        .unwrap_or(true);
    if allowed {
        *slot = Some(std::time::Instant::now());
    }
    allowed
}

/// Make the named schema available before the synchronous library answer runs.
/// A local client cache or a previously downloaded archive wins; only a missing
/// schema asks Demux for the `achievements:` spec.
pub(crate) async fn ensure_schema(app_id: &str, title: &str, language: &str) -> bool {
    if achievements_for(app_id, title, language).total_achievements > 0 {
        return true;
    }
    let mut meta = meta_for(app_id, title);
    if meta.is_none() && super::ubi_vault::load().is_some() && metadata_refresh_allowed() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            super::ubi_direct::refresh_achievement_metadata(),
        )
        .await;
        meta = meta_for(app_id, title);
    }
    let Some(meta) = meta else {
        return false;
    };
    if schema_cache_path(&meta)
        .and_then(|path| load_schema(&path))
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
    {
        return achievements_for(app_id, title, language).total_achievements > 0;
    }
    download_schema(&meta).await.is_ok()
        && achievements_for(app_id, title, language).total_achievements > 0
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
fn schema_path_for(roots: &[PathBuf], ids: &[String], spec: &str) -> Option<PathBuf> {
    let prefixes: Vec<String> = ids
        .iter()
        .filter(|id| !id.is_empty())
        .map(|id| format!("{id}_"))
        .collect();
    let wanted = normalize_spec(spec);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut fallback: Option<(std::time::SystemTime, PathBuf)> = None;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_prefix = prefixes.iter().any(|prefix| name.starts_with(prefix));
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

/// Matches a configuration row by space id, then product/launch id, then title.
fn config_match<'a>(
    rows: &'a [super::ubisoft::UbiRow],
    app_id: &str,
    title: &str,
) -> Option<&'a super::ubisoft::UbiRow> {
    rows.iter()
        .find(|r| !app_id.is_empty() && !r.space_id.is_empty() && r.space_id.eq_ignore_ascii_case(app_id))
        .or_else(|| {
            rows.iter().find(|r| {
                !app_id.is_empty()
                    && (r.launch_id.to_string() == app_id || r.install_id.to_string() == app_id)
            })
        })
        .or_else(|| {
            let key = super::scan::slug(title);
            if key.is_empty() {
                return None;
            }
            rows.iter().find(|r| super::scan::slug(&r.name) == key)
        })
}

/// The achievements available for one Ubisoft game, from the local Connect
/// cache or from an archive the launcher downloaded itself. `id` is the library
/// card id (client launch id, or the catalog space id for an owned game the
/// client has not installed). The configuration cache and the ownership
/// metadata cache bridge a space id to the archive spec and the product id.
pub(crate) fn achievements_for(app_id: &str, title: &str, language: &str) -> GameAchievementsResponse {
    // An Epic copy has no Ubisoft product id; the title alone can still find
    // the client's cache through the configuration index.
    if app_id.is_empty() && title.is_empty() {
        return GameAchievementsResponse::default();
    }
    let rows = super::ubisoft::config_rows();
    let entry = config_match(&rows, app_id, title);
    let meta = meta_for(app_id, title);
    let owned = super::ubisoft::load_owned();
    let title_key = super::scan::slug(title);
    let owned_entry = owned.iter().find(|row| {
        (!app_id.is_empty()
            && (row.id.eq_ignore_ascii_case(app_id) || row.product_id.to_string() == app_id))
            || (!title_key.is_empty() && super::scan::slug(&row.name) == title_key)
    });
    let spec = entry
        .map(|e| e.achievements.clone())
        .or_else(|| meta.as_ref().map(|m| m.achievements.clone()))
        .unwrap_or_default();
    let spool_id = entry
        .map(|e| e.launch_id)
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .or_else(|| {
            meta.as_ref()
                .and_then(|m| [m.product_id, m.uplay_id].into_iter().find(|id| *id > 0))
                .map(|id| id.to_string())
        })
        .or_else(|| {
            owned_entry
                .filter(|row| row.product_id > 0)
                .map(|row| row.product_id.to_string())
        })
        .or_else(|| {
            (!app_id.is_empty() && app_id.chars().all(|c| c.is_ascii_digit())).then(|| app_id.to_string())
        });
    let mut candidate_ids = Vec::new();
    if !app_id.is_empty() {
        candidate_ids.push(app_id.to_string());
    }
    if let Some(row) = entry {
        for id in [row.install_id, row.launch_id] {
            if id > 0 {
                let text = id.to_string();
                if !candidate_ids.contains(&text) {
                    candidate_ids.push(text);
                }
            }
        }
    }
    if let Some(meta) = &meta {
        for id in [meta.product_id, meta.uplay_id] {
            if id > 0 {
                let text = id.to_string();
                if !candidate_ids.contains(&text) {
                    candidate_ids.push(text);
                }
            }
        }
    }
    if let Some(row) = owned_entry {
        if row.product_id > 0 {
            let text = row.product_id.to_string();
            if !candidate_ids.contains(&text) {
                candidate_ids.push(text);
            }
        }
        if !row.id.is_empty() && !candidate_ids.contains(&row.id) {
            candidate_ids.push(row.id.clone());
        }
    }

    let roots = achievements_roots();
    if roots.is_empty() {
        return GameAchievementsResponse::default();
    }
    let Some(schema) = schema_path_for(&roots, &candidate_ids, &spec) else {
        return GameAchievementsResponse::default();
    };
    let Some(rows) = load_schema(&schema) else {
        return GameAchievementsResponse::default();
    };
    if rows.is_empty() {
        return GameAchievementsResponse::default();
    }
    let earned = spool_id
        .and_then(|id| spool_root().and_then(|spool_root| spool_path(&spool_root, &id)))
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| parse_spool(&bytes))
        .unwrap_or_default();

    let mut achievements = Vec::with_capacity(rows.len());
    for row in rows.iter() {
        let unlocked_at = earned.get(&row.id.parse::<u64>().unwrap_or(u64::MAX)).copied();
        let unlocked = unlocked_at.is_some();
        let icon_link = row.icon.clone().unwrap_or_default();
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
            icon_id: row.id.clone(),
            icon_link,
            tier: None,
            rarity: None,
            hidden: false,
            is_base: true,
            hardcore: false,
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
        assert_eq!(
            rows[0].icon.as_deref(),
            Some("data:image/png;base64,UE5H")
        );
        assert_eq!(rows[1].id, "2");
        assert!(rows[1].icon.is_none());
    }

    #[test]
    fn a_parsed_schema_is_reused_until_the_archive_changes() {
        let dir = std::env::temp_dir().join(format!("efxlve-ubi-schema-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("schema.zip");
        let first_loc = "1\tOne\tFirst\n";
        let first_zip = build_zip(&[("en-US_loc.txt", first_loc.as_bytes())]);
        std::fs::write(&path, &first_zip).expect("write schema");
        let first = load_schema(&path).expect("first schema");
        let second = load_schema(&path).expect("cached schema");
        assert!(Arc::ptr_eq(&first, &second));

        // A different length guarantees a miss even on a coarse mtime.
        let second_loc = "1\tOne\tFirst\n2\tTwo\tSecond\n";
        let second_zip = build_zip(&[("en-US_loc.txt", second_loc.as_bytes())]);
        std::fs::write(&path, &second_zip).expect("rewrite schema");
        let third = load_schema(&path).expect("rewritten schema");
        assert!(!Arc::ptr_eq(&first, &third));
        assert_eq!(third.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
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
    fn achievement_assets_use_the_connect_cdn() {
        assert_eq!(
            achievement_asset_url("114e5afa77fec3c93829176268c39f52").as_deref(),
            Some(
                "https://static3.cdn.ubi.com/orbit/uplay_launcher_3_0/assets/114e5afa77fec3c93829176268c39f52"
            )
        );
        assert_eq!(
            achievement_asset_url("ACOrigins.zip").as_deref(),
            Some(
                "https://static3.cdn.ubi.com/orbit/uplay_launcher_3_0/assets/acorigins"
            )
        );
        assert_eq!(
            achievement_asset_url(
                "https://static3.cdn.ubi.com/orbit/uplay_launcher_3_0/assets/abc?x=1"
            )
            .as_deref(),
            Some("https://static3.cdn.ubi.com/orbit/uplay_launcher_3_0/assets/abc")
        );
        assert!(achievement_asset_url("").is_none());
        assert!(achievement_asset_url("https://example.invalid/abc").is_none());
        // A path is reduced to its safe basename, never followed as a path.
        assert!(achievement_asset_url("../abc").is_some());
        assert!(achievement_asset_url("../a b").is_none());
    }

    #[tokio::test]
    #[ignore = "needs a linked session; downloads Far Cry 4 from the metadata cache"]
    async fn live_metadata_schema_downloads_from_metadata() {
        assert!(ensure_schema("61412", "Far Cry 4", "en").await);
        let data = achievements_for("61412", "Far Cry 4", "en");
        println!(
            "{} achievements, {} unlocked",
            data.total_achievements, data.user_unlocked
        );
        assert!(data.total_achievements > 0);
    }

    #[test]
    #[ignore = "reads the downloaded schema and the local Watch Dogs spool"]
    fn live_downloaded_schema_serves_achievements() {
        let data = achievements_for("1843", "Watch Dogs", "en");
        println!(
            "{} achievements, {} unlocked",
            data.total_achievements, data.user_unlocked
        );
        assert!(data.total_achievements > 0);
    }

    #[tokio::test]
    #[ignore = "downloads a public achievement archive from Ubisoft's CDN"]
    async fn live_downloads_a_known_achievement_schema() {
        let meta = AchievementMeta {
            product_id: 1843,
            uplay_id: 1843,
            name: "Watch Dogs".into(),
            achievements: "114e5afa77fec3c93829176268c39f52".into(),
            ..Default::default()
        };
        let path = download_schema(&meta).await.expect("schema download");
        let bytes = std::fs::read(&path).expect("schema bytes");
        let rows = parse_schema(&bytes);
        println!("{} rows in {}", rows.len(), path.display());
        assert!(!rows.is_empty());
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
