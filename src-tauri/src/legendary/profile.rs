use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bumped when cached achievement titles are rewritten from library metadata.
const TITLE_REVISION: u32 = 1;

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
    #[serde(rename = "isBase")]
    _is_base: Option<bool>,
    #[serde(rename = "totalUnlocked")]
    _total_unlocked: Option<u32>,
    #[serde(rename = "totalXP")]
    _total_xp: Option<u32>,
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
    _achievement_sets: Vec<GqlAchievementSet>,
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
    cover: Option<String>,
    total_achievements: u32,
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

fn is_library_base(categories: &[String], has_main_game: bool, kind: Option<&str>, title: &str) -> bool {
    if has_main_game || kind.is_some() || is_opaque_id(title) {
        return false;
    }
    let games = categories.iter().any(|c| c == "games");
    let extra = categories.iter().any(|c| c == "digitalextras" || c == "addons" || c.starts_with("addons/"));
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
    let rest = product[base.len()..].trim_start_matches(|c: char| matches!(c, ' ' | '-' | ':' | '–' | '—' | '·'));
    !rest.is_empty()
}

fn choose_set_label(sandbox: &str, base_idx: usize, idxs: &[usize], entries: &[CatalogEntry]) -> String {
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
    best.and_then(|i| entries[i].product_label.clone()).unwrap_or_default()
}

fn totals_for(idxs: &[usize], preferred: usize, entries: &[CatalogEntry]) -> (u32, u32) {
    let preferred = &entries[preferred];
    if preferred.total_achievements > 0 {
        return (preferred.total_achievements, preferred.total_product_xp);
    }
    for &i in idxs {
        if entries[i].total_achievements > 0 {
            return (entries[i].total_achievements, entries[i].total_product_xp);
        }
    }
    (0, 0)
}

/// Map one achievement sandbox to the owned library game.
/// Artbook / Content stay a label on that same record; callers must not merge records.
fn resolve_achievement_identity(sandbox: &str, index: &CatalogIndex) -> AchievementIdentity {
    let sandbox = sandbox.trim();
    let unmatched = AchievementIdentity {
        app_name: sandbox.to_string(),
        app_title: sandbox.to_string(),
        set_label: String::new(),
        cover: None,
        total_achievements: 0,
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
        let (ach, xp) = totals_for(&idxs, base_idx, &index.entries);
        let base = &index.entries[base_idx];
        return AchievementIdentity {
            app_name: base.app_name.clone(),
            app_title: base.app_title.clone(),
            set_label,
            cover: base.cover.clone(),
            total_achievements: ach,
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
    AchievementIdentity {
        app_name: entry.app_name.clone(),
        app_title: title,
        set_label: String::new(),
        cover: entry.cover.clone(),
        total_achievements: entry.total_achievements,
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
    if let Some(arr) = val.pointer("/metadata/categories").and_then(|c| c.as_array()) {
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
    }

    Some(CatalogEntry {
        app_name,
        app_title,
        cover: pick_best_cover(val),
        total_achievements: total_ach,
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

pub fn profile_cache_path(config: &Path) -> PathBuf {
    config.join("profile_cache.json")
}

/// Fetches user profile and achievement data from the official Epic Games GraphQL API
pub async fn fetch_player_profile(
    config: &Path,
    force_refresh: bool,
) -> Result<EpicPlayerProfile, String> {
    let cache_file = profile_cache_path(config);

    // 1. Cache check. Ignore a file left by a different Epic account.
    let active_account = fs::read_to_string(config.join("user.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|user| {
            user.get("account_id")
                .and_then(|v| v.as_str())
                .map(|id| id.to_string())
        });
    if !force_refresh && cache_file.is_file() {
        if let Ok(content) = fs::read_to_string(&cache_file) {
            if let Ok(mut prof) = serde_json::from_str::<EpicPlayerProfile>(&content) {
                let same_account = active_account
                    .as_deref()
                    .is_some_and(|id| id == prof.account_id);
                if same_account {
                    upgrade_cached_titles(config, &mut prof);
                    return Ok(prof);
                }
            }
        }
    }

    // 2. Read the signed-in account from user.json. Do not spawn legendary for this.
    let user_file = config.join("user.json");
    if !user_file.is_file() {
        return Err("@t:profile.notLoggedIn".into());
    }

    let user_content =
        fs::read_to_string(&user_file).map_err(|e| format!("@t:profile.userReadFailed\u{1f}{e}"))?;
    let user_json: serde_json::Value =
        serde_json::from_str(&user_content).map_err(|e| format!("@t:profile.userInvalid\u{1f}{e}"))?;

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

    let access_token = user_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "@t:profile.noAccessToken".to_string())?;

    // 3. Prepare the GraphQL query
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

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("@t:profile.httpClientFailed\u{1f}{e}"))?;

    let url = "https://launcher.store.epicgames.com/graphql";
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", access_token))
        .header(
            "User-Agent",
            "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live",
        )
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("@t:profile.graphqlConnectFailed\u{1f}{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err("@t:profile.tokenExpired".into());
        }
        return Err(format!(
            "@t:profile.graphqlError\u{1f}{}\u{1f}{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Bilinmeyen hata")
        ));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| format!("@t:profile.graphqlReadFailed\u{1f}{e}"))?;

    let gql_resp: GqlResponse =
        serde_json::from_str(&text).map_err(|e| format!("@t:profile.graphqlParseFailed\u{1f}{e}"))?;

    let records = gql_resp
        .data
        .and_then(|d| d.player_achievement)
        .and_then(|p| p.player_achievement_game_records)
        .and_then(|r| r.records)
        .unwrap_or_default();

    // 4. Match each sandbox to library metadata by app name, namespace, or catalog id.
    let catalog = scan_catalog_index(config);

    let mut game_records: Vec<ProfileGameRecord> = Vec::new();
    let mut total_unlocked = 0u32;
    let mut platinum_count = 0u32;
    let mut base_xp = 0u32;

    for r in records {
        let sb = r.sandbox_id.clone();
        let identity = resolve_achievement_identity(&sb, &catalog);

        let app_name = identity.app_name.clone();
        let app_title = identity.app_title.clone();
        let set_label = identity.set_label.clone();
        let cover = identity.cover.clone();

        let unl = r.total_unlocked.unwrap_or(0);
        let xp = r.total_xp.unwrap_or(0);

        let is_plat = r
            .player_awards
            .iter()
            .any(|a| a.award_type.as_deref().unwrap_or("").eq_ignore_ascii_case("PLATINUM"));

        let last_date = r
            .player_awards
            .iter()
            .filter_map(|a| a.unlocked_date_time.as_ref())
            .next()
            .cloned();

        let mut total_ach = identity.total_achievements;
        let mut total_prod_xp = identity.total_product_xp;

        // Fallback: when the achievement count is missing or 0 in metadata
        if total_ach == 0 && unl > 0 {
            total_ach = unl;
        }
        if total_prod_xp == 0 && xp > 0 {
            total_prod_xp = if xp > 1000 { xp } else { 1000 };
        }

        let mut percent = if total_ach > 0 {
            ((unl as f64 / total_ach as f64) * 100.0).round() as u32
        } else {
            0
        };

        if is_plat && percent < 100 {
            percent = 100;
        }

        total_unlocked += unl;
        base_xp += xp;
        if is_plat {
            platinum_count += 1;
        }

        game_records.push(ProfileGameRecord {
            sandbox_id: sb,
            app_name,
            app_title,
            cover,
            total_unlocked: unl,
            total_achievements: total_ach,
            total_xp: xp,
            total_product_xp: total_prod_xp,
            is_platinum: is_plat,
            unlocked_percent: percent,
            last_unlocked_date: last_date,
            set_label,
        });
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

    let now_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let profile = EpicPlayerProfile {
        account_id,
        display_name,
        total_xp,
        total_unlocked,
        platinum_count,
        games_count: game_records.len(),
        games: game_records,
        last_updated: now_epoch,
        title_revision: TITLE_REVISION,
    };

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
            sample("Boga", "Death Stranding", "f4a904", &["games", "applications"], false),
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
}
