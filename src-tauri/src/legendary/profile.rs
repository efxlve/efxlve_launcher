use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bumped when cached achievement titles are rewritten from library metadata.
const TITLE_REVISION: u32 = 1;

/// Bumped when cached totals or completion rules change and caches should refresh once.
const DATA_REVISION: u32 = 2;

const EPIC_OAUTH_URL: &str = "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
const EPIC_CLIENT_ID: &str = "34a02cf8f4414e29b15921876da36f9a";
const EPIC_CLIENT_SECRET: &str = "daafbccc737745039dffe53d94fc76cf";

/// Trailing product kinds Epic uses for split achievement catalogs.
/// Longer suffixes are listed first so "digital soundtrack" wins over "soundtrack".
const PRODUCT_KINDS: &[(&str, &str)] = &[
    ("digital soundtrack", "Soundtrack"),
    ("art book", "Art Book"),
    ("artbook", "Artbook"),
    ("soundtrack", "Soundtrack"),
    ("content", "Content"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileGameRecord {
    pub sandbox_id: String,
    pub app_name: String,
    pub app_title: String,
    pub cover: Option<String>,
    pub total_unlocked: u32,
    pub total_achievements: u32,
    pub total_xp: u32,
    pub total_product_xp: u32,
    pub is_platinum: bool,
    pub unlocked_percent: u32,
    pub last_unlocked_date: Option<String>,
    /// Short product kind ("Artbook", "Content") when this set is not the base game.
    /// Empty for a normal game row. Progress stays on this record either way.
    #[serde(default)]
    pub set_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpicPlayerProfile {
    pub account_id: String,
    pub display_name: String,
    pub total_xp: u32,
    pub total_unlocked: u32,
    pub platinum_count: u32,
    pub games_count: usize,
    pub games: Vec<ProfileGameRecord>,
    pub last_updated: u64,
    /// Cache files written before library-title resolution stay at 0 and are upgraded once.
    #[serde(default)]
    pub title_revision: u32,
    /// Cache files written by an older total model stay at 0 and are refetched once.
    #[serde(default)]
    pub data_revision: u32,
}

#[derive(Debug, Deserialize)]
struct GqlPlayerAward {
    #[serde(rename = "awardType")]
    award_type: Option<String>,
    #[serde(rename = "unlockedDateTime")]
    unlocked_date_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlAchievementSet {
    #[serde(rename = "achievementSetId")]
    _achievement_set_id: Option<String>,
    #[serde(rename = "isBase", alias = "is_base")]
    is_base: Option<bool>,
    #[serde(rename = "totalUnlocked", alias = "total_unlocked")]
    total_unlocked: Option<u32>,
    #[serde(rename = "totalXP", alias = "total_xp")]
    total_xp: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GqlGameRecord {
    #[serde(rename = "sandboxId")]
    sandbox_id: String,
    #[serde(rename = "totalXP")]
    total_xp: Option<u32>,
    #[serde(rename = "totalUnlocked")]
    total_unlocked: Option<u32>,
    #[serde(rename = "playerAwards", default)]
    player_awards: Vec<GqlPlayerAward>,
    #[serde(rename = "achievementSets", default)]
    achievement_sets: Vec<GqlAchievementSet>,
}

#[derive(Debug, Deserialize)]
struct GqlRecordsContainer {
    records: Option<Vec<GqlGameRecord>>,
}

#[derive(Debug, Deserialize)]
struct GqlPlayerAchievementData {
    #[serde(rename = "playerAchievementGameRecords")]
    player_achievement_game_records: Option<GqlRecordsContainer>,
}

#[derive(Debug, Deserialize)]
struct GqlData {
    #[serde(rename = "PlayerAchievement")]
    player_achievement: Option<GqlPlayerAchievementData>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GqlResponse {
    data: Option<GqlData>,
    errors: Option<Vec<serde_json::Value>>,
}

/// One catalog item from the on-disk library metadata.
struct CatalogEntry {
    app_name: String,
    app_title: String,
    cover: Option<String>,
    total_achievements: u32,
    base_achievements: u32,
    total_product_xp: u32,
    /// Lowercased achievement namespace shared by a game and its extras.
    namespace: String,
    /// Lowercased app name and catalog ids. The shared namespace is not included,
    /// so a sandbox that equals the namespace is not treated as one specific extra.
    own_ids: Vec<String>,
    is_base_game: bool,
    is_digital_extra: bool,
    product_label: Option<String>,
}

struct CatalogIndex {
    entries: Vec<CatalogEntry>,
    /// app name, namespace, and catalog id → entry indexes. Built once per scan.
    by_key: HashMap<String, Vec<usize>>,
}

/// Title chosen for one achievement sandbox. Separate sandboxes stay separate records.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AchievementIdentity {
    app_name: String,
    app_title: String,
    set_label: String,
    sandbox_id: String,
    cover: Option<String>,
    total_achievements: u32,
    base_achievements: u32,
    total_product_xp: u32,
    matched: bool,
}

fn is_opaque_id(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 16 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// "Game - Artbook" / "Game Content" → the short kind. A plain game title returns none.
fn product_kind(title: &str) -> Option<&'static str> {
    let lower = title.trim().to_lowercase();
    for (suffix, label) in PRODUCT_KINDS {
        if lower.len() <= suffix.len() || !lower.ends_with(suffix) {
            continue;
        }
        let boundary = lower.len() - suffix.len();
        if !lower.is_char_boundary(boundary) {
            continue;
        }
        let prev = lower[..boundary].chars().next_back();
        if matches!(prev, Some(' ' | '-' | ':' | '–' | '—' | '·')) {
            return Some(*label);
        }
    }
    None
}

fn is_library_base(
    categories: &[String],
    has_main_game: bool,
    kind: Option<&str>,
    title: &str,
) -> bool {
    if has_main_game || kind.is_some() || is_opaque_id(title) {
        return false;
    }
    let games = categories.iter().any(|c| c == "games");
    let extra = categories
        .iter()
        .any(|c| c == "digitalextras" || c == "addons" || c.starts_with("addons/"));
    games && !extra
}

fn push_unique(list: &mut Vec<String>, value: &str) {
    let value = value.trim().to_lowercase();
    if value.is_empty() || list.iter().any(|existing| existing == &value) {
        return;
    }
    list.push(value);
}

fn insert_key(map: &mut HashMap<String, Vec<usize>>, key: &str, idx: usize) {
    let key = key.trim().to_lowercase();
    if key.is_empty() {
        return;
    }
    let list = map.entry(key).or_default();
    if !list.contains(&idx) {
        list.push(idx);
    }
}

fn index_entries(entries: Vec<CatalogEntry>) -> CatalogIndex {
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, entry) in entries.iter().enumerate() {
        insert_key(&mut by_key, &entry.app_name, idx);
        insert_key(&mut by_key, &entry.namespace, idx);
        for id in &entry.own_ids {
            insert_key(&mut by_key, id, idx);
        }
    }
    CatalogIndex { entries, by_key }
}

fn candidate_indexes(sandbox: &str, index: &CatalogIndex) -> Vec<usize> {
    let key = sandbox.trim().to_lowercase();
    if key.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(list) = index.by_key.get(&key) {
        for &i in list {
            if seen.insert(i) {
                out.push(i);
            }
        }
    }
    // One hop through the shared namespace so an extra's sandbox still finds the base game.
    let seeds = out.clone();
    for i in seeds {
        let ns = &index.entries[i].namespace;
        if ns.is_empty() {
            continue;
        }
        if let Some(list) = index.by_key.get(ns) {
            for &j in list {
                if seen.insert(j) {
                    out.push(j);
                }
            }
        }
    }
    out
}

fn better_base(sandbox: &str, candidate: &CatalogEntry, current: &CatalogEntry) -> bool {
    let key = sandbox.trim();
    let cand_exact = candidate.app_name.eq_ignore_ascii_case(key);
    let curr_exact = current.app_name.eq_ignore_ascii_case(key);
    if cand_exact != curr_exact {
        return cand_exact;
    }
    let cand_human = !is_opaque_id(&candidate.app_name);
    let curr_human = !is_opaque_id(&current.app_name);
    if cand_human != curr_human {
        return cand_human;
    }
    false
}

fn best_base(sandbox: &str, idxs: &[usize], entries: &[CatalogEntry]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for &i in idxs {
        if !entries[i].is_base_game {
            continue;
        }
        best = Some(match best {
            None => i,
            Some(prev) => {
                if better_base(sandbox, &entries[i], &entries[prev]) {
                    i
                } else {
                    prev
                }
            }
        });
    }
    best
}

fn better_extra(candidate: &CatalogEntry, current: &CatalogEntry) -> bool {
    if candidate.is_digital_extra != current.is_digital_extra {
        return candidate.is_digital_extra;
    }
    candidate.app_title.len() < current.app_title.len()
}

fn title_extends(base_title: &str, product_title: &str) -> bool {
    let base = base_title.trim().to_lowercase();
    let product = product_title.trim().to_lowercase();
    if base.is_empty() || product.len() <= base.len() || !product.starts_with(&base) {
        return false;
    }
    let rest = product[base.len()..]
        .trim_start_matches(|c: char| matches!(c, ' ' | '-' | ':' | '–' | '—' | '·'));
    !rest.is_empty()
}

fn choose_set_label(
    sandbox: &str,
    base_idx: usize,
    idxs: &[usize],
    entries: &[CatalogEntry],
) -> String {
    let key = sandbox.trim().to_lowercase();
    for &i in idxs {
        if i == base_idx {
            continue;
        }
        let entry = &entries[i];
        if entry.product_label.is_none() {
            continue;
        }
        if entry.app_name.eq_ignore_ascii_case(&key) || entry.own_ids.iter().any(|id| id == &key) {
            return entry.product_label.clone().unwrap_or_default();
        }
    }
    let base_title = &entries[base_idx].app_title;
    let mut best: Option<usize> = None;
    for &i in idxs {
        if i == base_idx || entries[i].product_label.is_none() {
            continue;
        }
        if !title_extends(base_title, &entries[i].app_title) {
            continue;
        }
        best = Some(match best {
            None => i,
            Some(prev) => {
                if better_extra(&entries[i], &entries[prev]) {
                    i
                } else {
                    prev
                }
            }
        });
    }
    best.and_then(|i| entries[i].product_label.clone())
        .unwrap_or_default()
}

fn totals_for(idxs: &[usize], preferred: usize, entries: &[CatalogEntry]) -> (u32, u32, u32) {
    let preferred = &entries[preferred];
    if preferred.total_achievements > 0 {
        return (
            preferred.total_achievements,
            preferred.total_product_xp,
            preferred.base_achievements,
        );
    }
    for &i in idxs {
        if entries[i].total_achievements > 0 {
            return (
                entries[i].total_achievements,
                entries[i].total_product_xp,
                entries[i].base_achievements,
            );
        }
    }
    (0, 0, 0)
}

/// Map one achievement sandbox to the owned library game.
/// Artbook / Content stay a label on that same record; callers must not merge records.
fn resolve_achievement_identity(sandbox: &str, index: &CatalogIndex) -> AchievementIdentity {
    let sandbox = sandbox.trim();
    let unmatched = AchievementIdentity {
        app_name: sandbox.to_string(),
        app_title: sandbox.to_string(),
        set_label: String::new(),
        sandbox_id: sandbox.to_string(),
        cover: None,
        total_achievements: 0,
        base_achievements: 0,
        total_product_xp: 0,
        matched: false,
    };
    if sandbox.is_empty() {
        return unmatched;
    }
    let idxs = candidate_indexes(sandbox, index);
    if idxs.is_empty() {
        return unmatched;
    }
    if let Some(base_idx) = best_base(sandbox, &idxs, &index.entries) {
        let set_label = choose_set_label(sandbox, base_idx, &idxs, &index.entries);
        let (ach, xp, base_ach) = totals_for(&idxs, base_idx, &index.entries);
        let base = &index.entries[base_idx];
        let sandbox_id = if !base.namespace.is_empty() {
            base.namespace.clone()
        } else {
            sandbox.to_string()
        };
        return AchievementIdentity {
            app_name: base.app_name.clone(),
            app_title: base.app_title.clone(),
            set_label,
            sandbox_id,
            cover: base.cover.clone(),
            total_achievements: ach,
            base_achievements: base_ach,
            total_product_xp: xp,
            matched: true,
        };
    }
    let fallback = idxs
        .iter()
        .copied()
        .find(|i| !is_opaque_id(&index.entries[*i].app_title))
        .or_else(|| idxs.first().copied());
    let Some(i) = fallback else {
        return unmatched;
    };
    let entry = &index.entries[i];
    let title = if is_opaque_id(&entry.app_title) {
        sandbox.to_string()
    } else {
        entry.app_title.clone()
    };
    let sandbox_id = if !entry.namespace.is_empty() {
        entry.namespace.clone()
    } else {
        sandbox.to_string()
    };
    AchievementIdentity {
        app_name: entry.app_name.clone(),
        app_title: title,
        set_label: String::new(),
        sandbox_id,
        cover: entry.cover.clone(),
        total_achievements: entry.total_achievements,
        base_achievements: entry.base_achievements,
        total_product_xp: entry.total_product_xp,
        matched: true,
    }
}

fn pick_best_cover(meta: &serde_json::Value) -> Option<String> {
    let key_images = meta
        .get("metadata")
        .and_then(|m| m.get("keyImages"))
        .or_else(|| meta.get("keyImages"))
        .and_then(|k| k.as_array())?;

    let priorities = [
        "DieselGameBoxTall",
        "OfferImageTall",
        "DieselStoreFrontTall",
        "DieselGameBox",
        "OfferImageWide",
        "Thumbnail",
    ];

    for p in priorities {
        if let Some(img) = key_images.iter().find(|i| {
            i.get("type")
                .and_then(|t| t.as_str())
                .map(|s| s == p)
                .unwrap_or(false)
        }) {
            if let Some(url) = img.get("url").and_then(|u| u.as_str()) {
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
        }
    }

    // First valid URL
    for img in key_images {
        if let Some(url) = img.get("url").and_then(|u| u.as_str()) {
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }

    None
}

fn json_str<'a>(val: &'a serde_json::Value, pointer: &str) -> &'a str {
    val.pointer(pointer).and_then(|v| v.as_str()).unwrap_or("")
}

fn catalog_entry_from_meta(val: &serde_json::Value) -> Option<CatalogEntry> {
    let app_name = val
        .get("app_name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if app_name.is_empty() {
        return None;
    }

    let raw_title = val
        .get("app_title")
        .or_else(|| val.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim();
    let meta_title = json_str(val, "/metadata/title").trim();
    let app_title = if !raw_title.is_empty() && !is_opaque_id(raw_title) {
        raw_title.to_string()
    } else if !meta_title.is_empty() && !is_opaque_id(meta_title) {
        meta_title.to_string()
    } else if !raw_title.is_empty() {
        raw_title.to_string()
    } else {
        app_name.clone()
    };

    let mut namespace = json_str(val, "/metadata/namespace").trim().to_string();
    if namespace.is_empty() {
        namespace = json_str(val, "/achievements/namespace").trim().to_string();
    }
    if namespace.is_empty() {
        if let Some(assets) = val.get("asset_infos").and_then(|a| a.as_object()) {
            for asset in assets.values() {
                if let Some(ns) = asset.get("namespace").and_then(|v| v.as_str()) {
                    if !ns.trim().is_empty() {
                        namespace = ns.trim().to_string();
                        break;
                    }
                }
            }
        }
    }
    let namespace = namespace.to_lowercase();

    let mut own_ids = Vec::new();
    push_unique(&mut own_ids, &app_name);
    push_unique(&mut own_ids, json_str(val, "/metadata/id"));
    push_unique(&mut own_ids, json_str(val, "/metadata/catalogItemId"));
    if let Some(assets) = val.get("asset_infos").and_then(|a| a.as_object()) {
        for asset in assets.values() {
            if let Some(id) = asset.get("catalog_item_id").and_then(|v| v.as_str()) {
                push_unique(&mut own_ids, id);
            }
        }
    }

    let mut categories = Vec::new();
    if let Some(arr) = val
        .pointer("/metadata/categories")
        .and_then(|c| c.as_array())
    {
        for cat in arr {
            if let Some(path) = cat.get("path").and_then(|p| p.as_str()) {
                let path = path.trim().to_lowercase();
                if !path.is_empty() {
                    categories.push(path);
                }
            }
        }
    }
    let has_main = val
        .pointer("/metadata/mainGameItem")
        .map(|v| v.is_object())
        .unwrap_or(false);
    let kind = product_kind(&app_title);
    let is_base_game = is_library_base(&categories, has_main, kind, &app_title);
    let product_label = kind.map(|label| label.to_string());
    let is_digital_extra = categories
        .iter()
        .any(|c| c == "digitalextras" || c == "addons" || c.starts_with("addons/"));

    let mut total_ach = 0u32;
    let mut base_ach = 0u32;
    let mut total_xp = 0u32;
    if let Some(ach) = val.get("achievements") {
        total_ach = ach
            .get("total_achievements")
            .or_else(|| ach.get("totalAchievements"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        total_xp = ach
            .get("total_product_xp")
            .or_else(|| ach.get("totalProductXP"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        if let Some(sets) = ach
            .get("achievement_sets")
            .or_else(|| ach.get("achievementSets"))
            .and_then(|s| s.as_array())
        {
            for set in sets {
                let is_base = set
                    .get("isBase")
                    .or_else(|| set.get("is_base"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if is_base {
                    let count = set
                        .get("totalAchievements")
                        .or_else(|| set.get("total_achievements"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    base_ach = base_ach.saturating_add(count);
                }
            }
        }
    }

    Some(CatalogEntry {
        app_name,
        app_title,
        cover: pick_best_cover(val),
        total_achievements: total_ach,
        base_achievements: base_ach,
        total_product_xp: total_xp,
        namespace,
        own_ids,
        is_base_game,
        is_digital_extra,
        product_label,
    })
}

/// Scans the metadata/*.json files on disk and indexes them by id.
fn scan_catalog_index(config: &Path) -> CatalogIndex {
    let mut list = Vec::new();
    let meta_dir = config.join("metadata");
    if meta_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(meta_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) else {
                    continue;
                };
                if let Some(item) = catalog_entry_from_meta(&val) {
                    list.push(item);
                }
            }
        }
    }
    index_entries(list)
}

/// Rewrite cached rows once so Artbook/Content titles pick up the library game.
fn upgrade_cached_titles(config: &Path, prof: &mut EpicPlayerProfile) {
    if prof.title_revision >= TITLE_REVISION {
        return;
    }
    let index = scan_catalog_index(config);
    if index.entries.is_empty() && !prof.games.is_empty() {
        return;
    }
    for game in &mut prof.games {
        let identity = resolve_achievement_identity(&game.sandbox_id, &index);
        if !identity.matched {
            continue;
        }
        game.app_name = identity.app_name;
        game.app_title = identity.app_title;
        game.set_label = identity.set_label;
        if identity.cover.is_some() {
            game.cover = identity.cover;
        }
        if identity.total_achievements > 0 && game.total_achievements == 0 {
            game.total_achievements = identity.total_achievements;
        }
        if identity.total_product_xp > 0 && game.total_product_xp == 0 {
            game.total_product_xp = identity.total_product_xp;
        }
    }
    prof.title_revision = TITLE_REVISION;
    if let Ok(serialized) = serde_json::to_string_pretty(prof) {
        let _ = fs::write(profile_cache_path(config), serialized);
    }
}

/// A platinum award is proof that every achievement in the set was unlocked, so
/// the unlocked count is also its size. Epic's metadata for third-party titles
/// (EA App, Ubisoft) carries no `achievements` block; leaving the total at 0
/// gave the profile card an empty progress bar and no denominator.
fn fill_platinum_total(game: &mut ProfileGameRecord) {
    if game.is_platinum && game.total_achievements == 0 && game.total_unlocked > 0 {
        game.total_achievements = game.total_unlocked;
        game.unlocked_percent = 100;
    }
}

/// Rewrite cached rows written before a platinum filled its own set size.
fn upgrade_cached_platinum_totals(config: &Path, prof: &mut EpicPlayerProfile) {
    let missing = prof
        .games
        .iter()
        .any(|g| g.is_platinum && g.total_achievements == 0 && g.total_unlocked > 0);
    if !missing {
        return;
    }
    for game in &mut prof.games {
        fill_platinum_total(game);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(prof) {
        let _ = fs::write(profile_cache_path(config), serialized);
    }
}

pub fn profile_cache_path(config: &Path) -> PathBuf {
    config.join("profile_cache.json")
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses an ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS(.fff)?(Z|+00:00)`) into UNIX seconds.
fn parse_iso_utc_secs(ts: &str) -> Option<u64> {
    let trimmed = ts.trim();
    let rest = if let Some(s) = trimmed.strip_suffix('Z') {
        s
    } else if let Some(s) = trimmed
        .strip_suffix("+00:00")
        .or_else(|| trimmed.strip_suffix("-00:00"))
    {
        s
    } else {
        return None;
    };
    let (date_part, time_part) = rest.split_once('T')?;
    let mut dp = date_part.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;
    if dp.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time_core = time_part.split('.').next().unwrap_or(time_part);
    let mut tp = time_core.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    if tp.next().is_some() || hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec;
    u64::try_from(secs).ok()
}

fn token_needs_refresh(user_json: &serde_json::Value, now_secs: u64) -> bool {
    match user_json.get("expires_at").and_then(|v| v.as_str()) {
        Some(ts) => parse_iso_utc_secs(ts).is_some_and(|exp| exp <= now_secs + 60),
        None => false,
    }
}

async fn refresh_epic_access_token(
    client: &reqwest::Client,
    config: &Path,
    user_file: &Path,
    user_json: &mut serde_json::Value,
) -> Option<String> {
    let refresh_token = user_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    let resp = client
        .post(EPIC_OAUTH_URL)
        .basic_auth(EPIC_CLIENT_ID, Some(EPIC_CLIENT_SECRET))
        .header(
            "User-Agent",
            "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live",
        )
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("token_type", "eg1"),
        ])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let oauth: serde_json::Value = resp.json().await.ok()?;
    let new_token = oauth
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    if let (Some(dst), Some(src)) = (user_json.as_object_mut(), oauth.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&user_json) {
            let _ = fs::write(user_file, serialized);
            super::accounts::archive_active_sidecars(config);
        }
    }

    Some(new_token)
}

enum GqlFetchError {
    Http(u16, String),
    Other(String),
}

impl GqlFetchError {
    fn into_message(self) -> String {
        match self {
            Self::Http(_, msg) | Self::Other(msg) => msg,
        }
    }
}

async fn post_profile_graphql(
    client: &reqwest::Client,
    access_token: &str,
    account_id: &str,
) -> Result<GqlResponse, GqlFetchError> {
    let query = r#"
        query PlayerGameAchievementProgress($epicAccountId: String!) {
          PlayerAchievement {
            playerAchievementGameRecords(
              epicAccountId: $epicAccountId
              includeAchievements: false
            ) {
              records {
                totalXP
                totalUnlocked
                playerAwards {
                  awardType
                  unlockedDateTime
                }
                achievementSets {
                  achievementSetId
                  isBase
                  totalUnlocked
                  totalXP
                }
                sandboxId
              }
            }
          }
        }
    "#;

    let payload = serde_json::json!({
        "query": query,
        "variables": {
            "epicAccountId": account_id
        }
    });

    let resp = client
        .post("https://launcher.store.epicgames.com/graphql")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", access_token))
        .header(
            "User-Agent",
            "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live",
        )
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| GqlFetchError::Other(format!("@t:profile.graphqlConnectFailed\u{1f}{e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let msg = if code == 401 {
            "@t:profile.tokenExpired".into()
        } else {
            format!(
                "@t:profile.graphqlError\u{1f}{}\u{1f}{}",
                code,
                status.canonical_reason().unwrap_or("Bilinmeyen hata")
            )
        };
        return Err(GqlFetchError::Http(code, msg));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| GqlFetchError::Other(format!("@t:profile.graphqlReadFailed\u{1f}{e}")))?;

    serde_json::from_str::<GqlResponse>(&text)
        .map_err(|e| GqlFetchError::Other(format!("@t:profile.graphqlParseFailed\u{1f}{e}")))
}

fn gql_error_looks_auth(errors: &[serde_json::Value]) -> bool {
    errors.iter().any(|err| {
        let s = err.to_string().to_lowercase();
        s.contains("unauth")
            || s.contains("token")
            || s.contains("expired")
            || s.contains("forbidden")
            || s.contains("401")
    })
}

fn recompute_record_progress(record: &mut ProfileGameRecord) {
    if record.total_achievements > 0 && record.total_unlocked >= record.total_achievements {
        record.is_platinum = true;
    }
    fill_platinum_total(record);
    record.unlocked_percent = if record.total_achievements > 0 {
        let pct = ((record.total_unlocked as f64 / record.total_achievements as f64) * 100.0)
            .round() as u32;
        pct.min(100)
    } else {
        0
    };
    if record.is_platinum && record.unlocked_percent < 100 {
        record.unlocked_percent = 100;
    }
}

fn record_from_gql(r: GqlGameRecord, catalog: &CatalogIndex) -> ProfileGameRecord {
    let sb = r.sandbox_id;
    let identity = resolve_achievement_identity(&sb, catalog);

    let unl = r.total_unlocked.unwrap_or_else(|| {
        r.achievement_sets
            .iter()
            .filter_map(|s| s.total_unlocked)
            .sum()
    });
    let xp = r.total_xp.unwrap_or_else(|| {
        r.achievement_sets
            .iter()
            .filter_map(|s| s.total_xp)
            .sum()
    });

    let has_plat_award = r.player_awards.iter().any(|a| {
        a.award_type
            .as_deref()
            .unwrap_or("")
            .eq_ignore_ascii_case("PLATINUM")
    });
    let base_unlocked: u32 = r
        .achievement_sets
        .iter()
        .filter(|s| s.is_base.unwrap_or(false))
        .filter_map(|s| s.total_unlocked)
        .sum();
    let base_plat = identity.base_achievements > 0 && base_unlocked >= identity.base_achievements;
    let all_plat = identity.total_achievements > 0 && unl >= identity.total_achievements;
    let is_plat = has_plat_award || base_plat || all_plat;

    let last_date = r
        .player_awards
        .iter()
        .filter_map(|a| a.unlocked_date_time.as_ref())
        .next()
        .cloned();

    let mut record = ProfileGameRecord {
        sandbox_id: sb,
        app_name: identity.app_name,
        app_title: identity.app_title,
        cover: identity.cover,
        total_unlocked: unl,
        total_achievements: identity.total_achievements,
        total_xp: xp,
        total_product_xp: identity.total_product_xp,
        is_platinum: is_plat,
        unlocked_percent: 0,
        last_unlocked_date: last_date,
        set_label: identity.set_label,
    };
    recompute_record_progress(&mut record);
    record
}

fn build_record_from_summary(
    app_name: &str,
    sum: &super::models::GameAchievementSummary,
    catalog: &CatalogIndex,
) -> ProfileGameRecord {
    let identity = resolve_achievement_identity(app_name, catalog);
    let total_achievements = if identity.total_achievements > 0 {
        identity.total_achievements
    } else {
        sum.total_achievements
    };
    let total_product_xp = if identity.total_product_xp > 0 {
        identity.total_product_xp
    } else {
        sum.total_xp
    };
    let base_plat =
        identity.base_achievements > 0 && sum.base_unlocked >= identity.base_achievements;
    let mut record = ProfileGameRecord {
        sandbox_id: identity.sandbox_id,
        app_name: if identity.matched {
            identity.app_name
        } else {
            app_name.to_string()
        },
        app_title: identity.app_title,
        cover: identity.cover,
        total_unlocked: sum.user_unlocked,
        total_achievements,
        total_xp: sum.user_xp,
        total_product_xp,
        is_platinum: sum.is_platinum || base_plat,
        unlocked_percent: 0,
        last_unlocked_date: None,
        set_label: identity.set_label,
    };
    recompute_record_progress(&mut record);
    record
}

fn merge_local_summaries(
    config: &Path,
    ach_cache_dir: Option<&Path>,
    catalog: &CatalogIndex,
    game_records: &mut Vec<ProfileGameRecord>,
) {
    let summaries = super::commands::scan_achievements_summary(
        config,
        ach_cache_dir.unwrap_or_else(|| Path::new("")),
    );
    if summaries.is_empty() {
        return;
    }

    let mut base_index: HashMap<String, usize> = HashMap::new();
    for (idx, g) in game_records.iter().enumerate() {
        if g.set_label.is_empty() {
            base_index
                .entry(g.app_name.to_lowercase())
                .or_insert(idx);
        }
    }

    for (app_name, sum) in summaries {
        if !sum.supported || (!sum.progress_known && sum.user_unlocked == 0 && !sum.is_platinum) {
            continue;
        }
        let key = app_name.to_lowercase();
        if let Some(&idx) = base_index.get(&key) {
            let game = &mut game_records[idx];
            if game.total_achievements == 0 && sum.total_achievements > 0 {
                game.total_achievements = sum.total_achievements;
            }
            if game.total_product_xp == 0 && sum.total_xp > 0 {
                game.total_product_xp = sum.total_xp;
            }
            if sum.user_unlocked > game.total_unlocked {
                game.total_unlocked = sum.user_unlocked;
            }
            if sum.user_xp > game.total_xp {
                game.total_xp = sum.user_xp;
            }
            if sum.is_platinum {
                game.is_platinum = true;
            }
            recompute_record_progress(game);
        } else {
            let record = build_record_from_summary(&app_name, &sum, catalog);
            base_index.insert(record.app_name.to_lowercase(), game_records.len());
            game_records.push(record);
        }
    }
}

fn finalize_profile(
    account_id: String,
    display_name: String,
    mut game_records: Vec<ProfileGameRecord>,
) -> EpicPlayerProfile {
    let mut total_unlocked = 0u32;
    let mut platinum_count = 0u32;
    let mut base_xp = 0u32;

    for game in &mut game_records {
        recompute_record_progress(game);
        total_unlocked += game.total_unlocked;
        base_xp += game.total_xp;
        if game.is_platinum {
            platinum_count += 1;
        }
    }

    // Epic Games Store grants a +250 XP bonus for each platinum trophy
    let total_xp = base_xp + (platinum_count * 250);

    // Sort games: platinums and high completion first, then by XP
    game_records.sort_by(|a, b| {
        b.is_platinum
            .cmp(&a.is_platinum)
            .then_with(|| b.unlocked_percent.cmp(&a.unlocked_percent))
            .then_with(|| b.total_xp.cmp(&a.total_xp))
            .then_with(|| a.app_title.cmp(&b.app_title))
            .then_with(|| a.set_label.cmp(&b.set_label))
    });

    EpicPlayerProfile {
        account_id,
        display_name,
        total_xp,
        total_unlocked,
        platinum_count,
        games_count: game_records.len(),
        games: game_records,
        last_updated: now_epoch_secs(),
        title_revision: TITLE_REVISION,
        data_revision: DATA_REVISION,
    }
}

fn recover_profile_fallback(
    config: &Path,
    ach_cache_dir: Option<&Path>,
    account_id: &str,
    display_name: &str,
    fallback_cached: Option<EpicPlayerProfile>,
    catalog: &CatalogIndex,
) -> Option<EpicPlayerProfile> {
    let mut games = match fallback_cached {
        Some(mut prof) => {
            if prof.title_revision < TITLE_REVISION {
                upgrade_cached_titles(config, &mut prof);
            }
            prof.games
        }
        None => Vec::new(),
    };

    merge_local_summaries(config, ach_cache_dir, catalog, &mut games);
    if games.is_empty() {
        return None;
    }

    Some(finalize_profile(
        account_id.to_string(),
        display_name.to_string(),
        games,
    ))
}

/// Fetches user profile and achievement data from the Epic Games GraphQL API,
/// refreshing expired OAuth tokens and falling back to cached/local achievement
/// records when offline or when Epic withholds records.
pub async fn fetch_player_profile(
    config: &Path,
    ach_cache_dir: Option<&Path>,
    force_refresh: bool,
) -> Result<EpicPlayerProfile, String> {
    let cache_file = profile_cache_path(config);

    // 1. Read user.json early so we always know the active account id.
    let user_file = config.join("user.json");
    let user_raw = fs::read_to_string(&user_file);
    let user_parsed = user_raw
        .as_ref()
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
    let active_account = user_parsed
        .as_ref()
        .and_then(|user| user.get("account_id").and_then(|v| v.as_str()))
        .map(|id| id.to_string());

    // Keep any valid same-account cache as a fallback if refresh fails or offline.
    let mut fallback_cached: Option<EpicPlayerProfile> = None;
    if cache_file.is_file() {
        if let Ok(content) = fs::read_to_string(&cache_file) {
            if let Ok(mut prof) = serde_json::from_str::<EpicPlayerProfile>(&content) {
                let same_account = active_account
                    .as_deref()
                    .is_some_and(|id| id == prof.account_id);
                if same_account {
                    if !force_refresh && prof.data_revision >= DATA_REVISION {
                        upgrade_cached_titles(config, &mut prof);
                        upgrade_cached_platinum_totals(config, &mut prof);
                        return Ok(prof);
                    }
                    fallback_cached = Some(prof);
                }
            }
        }
    }

    // 2. Read the signed-in account from user.json. Do not spawn legendary for this.
    if !user_file.is_file() {
        return Err("@t:profile.notLoggedIn".into());
    }
    let user_content = user_raw.map_err(|e| format!("@t:profile.userReadFailed\u{1f}{e}"))?;
    let mut user_json: serde_json::Value = serde_json::from_str(&user_content)
        .map_err(|e| format!("@t:profile.userInvalid\u{1f}{e}"))?;

    let account_id = user_json
        .get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "@t:profile.noAccountId".to_string())?
        .to_string();

    let display_name = user_json
        .get("displayName")
        .or_else(|| user_json.get("display_name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&account_id)
        .to_string();

    let mut access_token = user_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "@t:profile.noAccessToken".to_string())?
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("@t:profile.httpClientFailed\u{1f}{e}"))?;

    // 3. Refresh expired OAuth tokens before calling Epic GraphQL (which returns HTTP 500 on expired tokens).
    let mut refreshed = false;
    if token_needs_refresh(&user_json, now_epoch_secs()) {
        if let Some(new_token) =
            refresh_epic_access_token(&client, config, &user_file, &mut user_json).await
        {
            access_token = new_token;
            refreshed = true;
        }
    }

    let mut gql_result = post_profile_graphql(&client, &access_token, &account_id).await;
    let should_retry_auth = match &gql_result {
        Err(GqlFetchError::Http(code, _)) => !refreshed && matches!(code, 401 | 403 | 500),
        Ok(resp) => {
            !refreshed
                && resp
                    .data
                    .as_ref()
                    .and_then(|d| d.player_achievement.as_ref())
                    .and_then(|p| p.player_achievement_game_records.as_ref())
                    .and_then(|r| r.records.as_ref())
                    .is_none()
                && resp
                    .errors
                    .as_deref()
                    .is_some_and(gql_error_looks_auth)
        }
        Err(_) => false,
    };
    if should_retry_auth {
        if let Some(new_token) =
            refresh_epic_access_token(&client, config, &user_file, &mut user_json).await
        {
            access_token = new_token;
            gql_result = post_profile_graphql(&client, &access_token, &account_id).await;
        }
    }

    let catalog = scan_catalog_index(config);

    let gql_resp = match gql_result {
        Ok(resp) => resp,
        Err(err) => {
            if let Some(recovered) = recover_profile_fallback(
                config,
                ach_cache_dir,
                &account_id,
                &display_name,
                fallback_cached,
                &catalog,
            ) {
                return Ok(recovered);
            }
            return Err(err.into_message());
        }
    };

    let records_opt = gql_resp
        .data
        .and_then(|d| d.player_achievement)
        .and_then(|p| p.player_achievement_game_records)
        .and_then(|r| r.records);

    // 4. When Epic returns records: null (e.g. private profile or partial GraphQL error),
    // preserve any cached records and merge local achievement caches instead of writing an empty file.
    let Some(records) = records_opt else {
        if let Some(recovered) = recover_profile_fallback(
            config,
            ach_cache_dir,
            &account_id,
            &display_name,
            fallback_cached,
            &catalog,
        ) {
            return Ok(recovered);
        }
        return Ok(finalize_profile(account_id, display_name, Vec::new()));
    };

    let mut game_records: Vec<ProfileGameRecord> = records
        .into_iter()
        .map(|r| record_from_gql(r, &catalog))
        .collect();

    merge_local_summaries(config, ach_cache_dir, &catalog, &mut game_records);
    let profile = finalize_profile(account_id, display_name, game_records);

    // 5. Cache to disk and keep a copy in this account's archive.
    if let Ok(serialized) = serde_json::to_string_pretty(&profile) {
        let _ = fs::write(&cache_file, serialized);
        super::accounts::archive_active_sidecars(config);
    }

    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xp_calculation_with_platinum() {
        let base_xp = 13015u32;
        let platinum_count = 3u32;
        let total_xp = base_xp + (platinum_count * 250);
        assert_eq!(total_xp, 13765);
    }

    #[test]
    fn test_parse_gql_response() {
        let json_str = r#"{
            "data": {
                "PlayerAchievement": {
                    "playerAchievementGameRecords": {
                        "records": [
                            {
                                "sandboxId": "carnation",
                                "totalXP": 1000,
                                "totalUnlocked": 48,
                                "playerAwards": [
                                    { "awardType": "PLATINUM", "unlockedDateTime": "2024-01-01T00:00:00Z" }
                                ],
                                "achievementSets": []
                            },
                            {
                                "sandboxId": "some_other",
                                "totalXP": 500,
                                "totalUnlocked": 10,
                                "playerAwards": [],
                                "achievementSets": []
                            }
                        ]
                    }
                }
            }
        }"#;

        let res: GqlResponse = serde_json::from_str(json_str).expect("parse failed");
        let recs = res
            .data
            .unwrap()
            .player_achievement
            .unwrap()
            .player_achievement_game_records
            .unwrap()
            .records
            .unwrap();

        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].sandbox_id, "carnation");
        assert_eq!(recs[0].total_xp, Some(1000));
        assert_eq!(recs[0].total_unlocked, Some(48));
        assert!(recs[0]
            .player_awards
            .iter()
            .any(|a| a.award_type.as_deref() == Some("PLATINUM")));
    }

    fn sample(
        app_name: &str,
        title: &str,
        namespace: &str,
        categories: &[&str],
        has_main_game: bool,
    ) -> CatalogEntry {
        let cats: Vec<String> = categories.iter().map(|c| (*c).to_string()).collect();
        let kind = product_kind(title);
        CatalogEntry {
            app_name: app_name.to_string(),
            app_title: title.to_string(),
            cover: None,
            total_achievements: 63,
            base_achievements: 0,
            total_product_xp: 1000,
            namespace: namespace.to_string(),
            own_ids: vec![app_name.to_lowercase()],
            is_base_game: is_library_base(&cats, has_main_game, kind, title),
            is_digital_extra: cats.iter().any(|c| c == "digitalextras"),
            product_label: kind.map(|label| label.to_string()),
        }
    }

    #[test]
    fn product_kind_reads_artbook_and_content_suffixes() {
        assert_eq!(
            product_kind("DEATH STRANDING DIRECTOR'S CUT - Artbook"),
            Some("Artbook")
        );
        assert_eq!(product_kind("Death Stranding Content"), Some("Content"));
        assert_eq!(
            product_kind("DEATH STRANDING DIGITAL SOUNDTRACK"),
            Some("Soundtrack")
        );
        assert_eq!(product_kind("Death Stranding"), None);
        assert_eq!(product_kind("DEATH STRANDING DIRECTOR'S CUT"), None);
    }

    #[test]
    fn split_products_use_library_title_and_stay_separate() {
        let index = index_entries(vec![
            sample(
                "Boga",
                "Death Stranding",
                "f4a904",
                &["games", "applications"],
                false,
            ),
            sample(
                "content1",
                "Death Stranding Content",
                "f4a904",
                &["digitalextras", "games"],
                false,
            ),
            sample(
                "soundtrack1",
                "DEATH STRANDING DIGITAL SOUNDTRACK",
                "f4a904",
                &["games", "applications"],
                true,
            ),
            sample(
                "dc",
                "DEATH STRANDING DIRECTOR'S CUT",
                "0a9e3c",
                &["games", "applications"],
                false,
            ),
            sample(
                "art1",
                "DEATH STRANDING DIRECTOR'S CUT - Artbook",
                "0a9e3c",
                &["digitalextras", "applications"],
                false,
            ),
        ]);

        let content = resolve_achievement_identity("f4a904", &index);
        let artbook = resolve_achievement_identity("0a9e3c", &index);

        assert_eq!(content.app_title, "Death Stranding");
        assert_eq!(content.set_label, "Content");
        assert_eq!(content.app_name, "Boga");
        assert_eq!(artbook.app_title, "DEATH STRANDING DIRECTOR'S CUT");
        assert_eq!(artbook.set_label, "Artbook");
        assert_eq!(artbook.app_name, "dc");
        assert_ne!(content.app_name, artbook.app_name);
        assert_ne!(content.set_label, artbook.set_label);
    }

    #[test]
    fn opaque_sandbox_title_resolves_to_library_game() {
        let hex = "2e92a78949e2474aa89271b8b893f3b0";
        let index = index_entries(vec![
            sample(hex, hex, "carnation", &["games"], false),
            sample("carnation", "Alan Wake 2", "carnation", &["games"], false),
        ]);
        let identity = resolve_achievement_identity(hex, &index);
        assert_eq!(identity.app_title, "Alan Wake 2");
        assert_eq!(identity.app_name, "carnation");
        assert_eq!(identity.set_label, "");
        assert!(identity.matched);
    }

    #[test]
    fn extra_without_owned_game_keeps_product_title() {
        let index = index_entries(vec![sample(
            "content1",
            "Death Stranding Content",
            "f4a904",
            &["digitalextras", "games"],
            false,
        )]);
        let identity = resolve_achievement_identity("f4a904", &index);
        assert_eq!(identity.app_title, "Death Stranding Content");
        assert_eq!(identity.set_label, "");
    }

    #[test]
    fn unmatched_sandbox_stays_the_id() {
        let index = index_entries(vec![]);
        let identity = resolve_achievement_identity("not-a-game", &index);
        assert!(!identity.matched);
        assert_eq!(identity.app_title, "not-a-game");
        assert_eq!(identity.set_label, "");
    }

    fn profile_row(unlocked: u32, total: u32, platinum: bool) -> ProfileGameRecord {
        ProfileGameRecord {
            sandbox_id: "sandbox".into(),
            app_name: "game".into(),
            app_title: "Game".into(),
            cover: None,
            total_unlocked: unlocked,
            total_achievements: total,
            total_xp: 0,
            total_product_xp: 0,
            is_platinum: platinum,
            unlocked_percent: 0,
            last_unlocked_date: None,
            set_label: String::new(),
        }
    }

    #[test]
    fn a_platinum_award_fills_the_unknown_set_size() {
        // Star Wars Jedi: Fallen Order ("shoebill") is an EA title: Epic keeps
        // the unlocks and the platinum award, but its metadata has no
        // achievement total, which left the profile bar empty.
        let mut shoebill = profile_row(39, 0, true);
        fill_platinum_total(&mut shoebill);
        assert_eq!(shoebill.total_achievements, 39);
        assert_eq!(shoebill.unlocked_percent, 100);

        // Without a platinum, a missing total stays missing: never invent a
        // denominator for a set Epic did not describe.
        let mut partial = profile_row(10, 0, false);
        fill_platinum_total(&mut partial);
        assert_eq!(partial.total_achievements, 0);

        // A known catalog total is never replaced.
        let mut known = profile_row(10, 50, false);
        fill_platinum_total(&mut known);
        assert_eq!(known.total_achievements, 50);
    }

    #[test]
    fn iso_utc_timestamp_parses_and_checks_expiry() {
        assert_eq!(parse_iso_utc_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso_utc_secs("2026-01-01T00:00:00.123Z"),
            Some(1767225600)
        );
        assert_eq!(
            parse_iso_utc_secs("2026-01-01T00:00:00+00:00"),
            Some(1767225600)
        );
        assert_eq!(parse_iso_utc_secs("2026-01-01T00:00:00+03:00"), None);

        let stale = serde_json::json!({ "expires_at": "2026-01-01T00:01:00Z" });
        assert!(token_needs_refresh(&stale, 1767225600));
        let fresh = serde_json::json!({ "expires_at": "2026-01-01T05:00:00Z" });
        assert!(!token_needs_refresh(&fresh, 1767225600));
    }

    #[test]
    fn base_achievement_set_marks_platinum_without_award() {
        let meta = serde_json::json!({
            "app_name": "Brill",
            "app_title": "Dead by Daylight",
            "metadata": {
                "id": "dbd-id",
                "namespace": "611482b8586142cda48a0786eb8a127c",
                "categories": [{"path": "games"}]
            },
            "achievements": {
                "total_achievements": 280,
                "total_product_xp": 3000,
                "achievement_sets": [
                    { "achievementSetId": "bdmlp8o", "isBase": true, "totalAchievements": 56 },
                    { "achievementSetId": "16jml5b", "isBase": false, "totalAchievements": 224 }
                ]
            }
        });
        let entry = catalog_entry_from_meta(&meta).expect("entry");
        assert_eq!(entry.base_achievements, 56);
        let catalog = index_entries(vec![entry]);

        let gql_rec: GqlGameRecord = serde_json::from_value(serde_json::json!({
            "sandboxId": "611482b8586142cda48a0786eb8a127c",
            "totalXP": 2100,
            "totalUnlocked": 195,
            "playerAwards": [],
            "achievementSets": [
                { "achievementSetId": "bdmlp8o", "isBase": true, "totalUnlocked": 56, "totalXP": 1000 },
                { "achievementSetId": "16jml5b", "isBase": false, "totalUnlocked": 139, "totalXP": 1100 }
            ]
        }))
        .unwrap();

        let rec = record_from_gql(gql_rec, &catalog);
        assert_eq!(rec.app_name, "Brill");
        assert!(rec.is_platinum);
        assert_eq!(rec.unlocked_percent, 100);
        assert_eq!(rec.total_unlocked, 195);
        assert_eq!(rec.total_achievements, 280);
    }

    #[test]
    fn recover_profile_fallback_uses_cache_and_local_achievements() {
        let base = std::env::temp_dir().join(format!(
            "efxlve-profile-recover-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let config = base.join("config");
        let ach_cache = base.join("ach_cache");
        fs::create_dir_all(config.join("metadata")).unwrap();
        fs::create_dir_all(&ach_cache).unwrap();

        fs::write(
            config.join("metadata").join("Ginger.json"),
            serde_json::json!({
                "app_name": "Ginger",
                "app_title": "Cyberpunk 2077",
                "metadata": {
                    "id": "ginger-id",
                    "namespace": "77f2b98e2cef40c8a7437518bf420e47",
                    "categories": [{"path": "games"}]
                },
                "achievements": {
                    "namespace": "77f2b98e2cef40c8a7437518bf420e47",
                    "total_achievements": 57,
                    "total_product_xp": 1500,
                    "achievement_sets": [
                        { "isBase": true, "totalAchievements": 44 },
                        { "isBase": false, "totalAchievements": 13 }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();

        fs::write(
            config.join("achievements.json"),
            serde_json::json!({
                "77f2b98e2cef40c8a7437518bf420e47": {
                    "totalUnlocked": 44,
                    "totalXP": 1000,
                    "playerAwards": [],
                    "achievementSets": [
                        { "isBase": true, "totalUnlocked": 44, "totalXP": 1000 }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();

        let catalog = scan_catalog_index(&config);
        let recovered = recover_profile_fallback(
            &config,
            Some(&ach_cache),
            "acc123",
            "Player",
            None,
            &catalog,
        )
        .expect("should recover from local achievements");

        assert_eq!(recovered.platinum_count, 1);
        assert_eq!(recovered.total_unlocked, 44);
        assert_eq!(recovered.total_xp, 1250);
        assert_eq!(recovered.games.len(), 1);
        assert_eq!(recovered.games[0].app_name, "Ginger");
        assert!(recovered.games[0].is_platinum);

        let _ = fs::remove_dir_all(&base);
    }
}
