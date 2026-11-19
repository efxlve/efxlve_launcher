//! Epic achievement fetch, metadata enrichment, and library summary scan.

use super::prelude::*;

/// Fills in achievement hidden/is_base flags from the metadata file and fills
/// in any missing description/name/icons.
pub fn enrich_achievements_from_metadata(resp: &mut GameAchievementsResponse, app_name: &str) {
    let config = skip::default_config_dir();
    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    if !meta_path.is_file() {
        return;
    }
    if let Ok(content) = std::fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ach_meta) = val.get("achievements") {
                if let Some(arr) = ach_meta.get("achievements").and_then(|a| a.as_array()) {
                    for item in arr {
                        if let Some(meta_ach) = item.get("achievement") {
                            let name = meta_ach
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            if name.is_empty() {
                                continue;
                            }
                            let hidden = meta_ach
                                .get("hidden")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let is_base = meta_ach
                                .get("isBase")
                                .or_else(|| meta_ach.get("is_base"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let unlocked_name = meta_ach
                                .get("unlockedDisplayName")
                                .or_else(|| meta_ach.get("unlocked_display_name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let unlocked_desc = meta_ach
                                .get("unlockedDescription")
                                .or_else(|| meta_ach.get("unlocked_description"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let unlocked_icon = meta_ach
                                .get("unlockedIconLink")
                                .or_else(|| meta_ach.get("unlocked_icon_link"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();

                            if let Some(target) =
                                resp.achievements.iter_mut().find(|a| a.name == name)
                            {
                                if hidden {
                                    target.hidden = true;
                                }
                                target.is_base = is_base;
                                if target.display_name.trim().is_empty()
                                    && !unlocked_name.is_empty()
                                {
                                    target.display_name = unlocked_name.to_string();
                                }
                                if target.description.trim().is_empty() && !unlocked_desc.is_empty()
                                {
                                    target.description = unlocked_desc.to_string();
                                }
                                if target.icon_link.trim().is_empty() && !unlocked_icon.is_empty() {
                                    target.icon_link = unlocked_icon.to_string();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// EOS achievement unlocks read from a game's own log.
///
/// Some Epic titles (Nixxes ports such as Marvel's Spider-Man) publish no Epic
/// Games Store achievement set, so legendary returns nothing for them. The game
/// still writes one line per EOS unlock into a per-session log in Documents.
/// This is a best-effort local source; it never writes to the store.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EosLogUnlocks {
    pub log_path: Option<String>,
    pub unlocks: std::collections::BTreeMap<String, i64>,
}

/// Reads the current game log and merges it with the unlocks this launcher has
/// already seen. The log is replaced on every launch, so the cache keeps the
/// earlier sessions from disappearing when the game starts again.
#[tauri::command]
pub async fn epic_eos_log_unlocks(
    app: AppHandle,
    app_name: String,
    title: String,
) -> EosLogUnlocks {
    tauri::async_runtime::spawn_blocking(move || read_eos_log_unlocks(&app, &app_name, &title))
        .await
        .unwrap_or_default()
}

fn read_eos_log_unlocks(app: &AppHandle, app_name: &str, title: &str) -> EosLogUnlocks {
    let mut cached = load_eos_unlock_cache(app, app_name);
    let before = cached.clone();
    let log_path = find_eos_log(title);
    if let Some(path) = log_path.as_deref() {
        if let Some(text) = read_eos_log_text(path) {
            for (name, at) in parse_eos_unlocks(&text) {
                cached
                    .entry(name)
                    .and_modify(|old| *old = (*old).max(at))
                    .or_insert(at);
            }
        }
    }
    if cached != before {
        save_eos_unlock_cache(app, app_name, &cached);
    }
    EosLogUnlocks {
        log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        unlocks: cached,
    }
}

/// The cache lives beside the other achievement answers but in its own folder,
/// so the summary scan never mistakes it for a store response.
fn eos_unlock_cache_file(app: &AppHandle, app_name: &str) -> Option<PathBuf> {
    if app_name.is_empty()
        || !app_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("achievements")
        .join("eos_log");
    Some(dir.join(format!("{app_name}.json")))
}

fn load_eos_unlock_cache(
    app: &AppHandle,
    app_name: &str,
) -> std::collections::BTreeMap<String, i64> {
    let Some(path) = eos_unlock_cache_file(app, app_name) else {
        return std::collections::BTreeMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_eos_unlock_cache(
    app: &AppHandle,
    app_name: &str,
    unlocks: &std::collections::BTreeMap<String, i64>,
) {
    let Some(path) = eos_unlock_cache_file(app, app_name) else {
        return;
    };
    // Two live reads can overlap: merge with what is on disk now so the later
    // write cannot drop an unlock the other read already saved.
    let mut merged: std::collections::BTreeMap<String, i64> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    for (name, at) in unlocks {
        merged
            .entry(name.clone())
            .and_modify(|old| *old = (*old).max(*at))
            .or_insert(*at);
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&merged) {
        let _ = std::fs::write(path, text);
    }
}

/// Documents can be redirected to OneDrive, and portable Linux builds use
/// `HOME`; both roots are checked before giving up.
fn eos_documents_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(key) {
            let docs = PathBuf::from(home).join("Documents");
            if !roots.contains(&docs) {
                roots.push(docs);
            }
        }
    }
    if let Ok(onedrive) = std::env::var("OneDrive") {
        let docs = PathBuf::from(onedrive).join("Documents");
        if !roots.contains(&docs) {
            roots.push(docs);
        }
    }
    roots
}

fn find_eos_log(title: &str) -> Option<PathBuf> {
    let wanted = normalize_eos_title(title);
    if wanted.is_empty() {
        return None;
    }
    for docs in eos_documents_dirs() {
        for base in [docs.clone(), docs.join("My Games")] {
            if let Some(path) = find_eos_log_in(&base, &wanted) {
                return Some(path);
            }
        }
    }
    None
}

fn find_eos_log_in(base: &Path, wanted: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(base).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if normalize_eos_title(name) == wanted {
            if let Some(log) = newest_log_in(&path, wanted) {
                return Some(log);
            }
        }
    }
    None
}

fn newest_log_in(dir: &Path, wanted: &str) -> Option<PathBuf> {
    let mut best: Option<(bool, std::time::SystemTime, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_log = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("log"))
            .unwrap_or(false);
        if !is_log {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let exact = normalize_eos_title(stem) == wanted;
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let replace = match &best {
            None => true,
            Some((best_exact, best_time, _)) => {
                (exact && !best_exact) || (exact == *best_exact && modified > *best_time)
            }
        };
        if replace {
            best = Some((exact, modified, path));
        }
    }
    best.map(|(_, _, path)| path)
}

fn read_eos_log_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The line the EOS SDK-backed game writes on every unlock:
/// `[Epic] Achievement <name> unlocked at <unix seconds>`.
fn parse_eos_unlocks(text: &str) -> std::collections::BTreeMap<String, i64> {
    const PREFIX: &str = "[Epic] Achievement ";
    const SUFFIX: &str = " unlocked at ";
    let mut out: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for line in text.lines() {
        let Some(start) = line.find(PREFIX) else {
            continue;
        };
        let rest = &line[start + PREFIX.len()..];
        let Some(end) = rest.find(SUFFIX) else {
            continue;
        };
        let name = rest[..end].trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let stamp = rest[end + SUFFIX.len()..]
            .split_whitespace()
            .next()
            .unwrap_or("");
        let Ok(at) = stamp.parse::<i64>() else {
            continue;
        };
        out.entry(name.to_string())
            .and_modify(|old| *old = (*old).max(at))
            .or_insert(at);
    }
    out
}

/// Punctuation and edition tails differ between the Epic title and the folder
/// the game creates, so a case/punctuation-free compare is the only stable key.
fn normalize_eos_title(title: &str) -> String {
    let cleaned: String = title
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            // Apostrophes vanish, so "Marvel's" and "Marvels" name one folder.
            '\'' | '\u{2018}' | '\u{2019}' => None,
            c if c.is_ascii_alphanumeric() => Some(c),
            _ => Some(' '),
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[tauri::command]
pub async fn epic_get_achievements(
    app: AppHandle,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<GameAchievementsResponse, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("achievements");
    let cache_file = cache_dir.join(format!("{app_name}.json"));

    if !force_refresh.unwrap_or(false) && cache_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(mut data) = serde_json::from_str::<GameAchievementsResponse>(&content) {
                data.consolidate();
                enrich_achievements_from_metadata(&mut data, &app_name);
                data.consolidate();
                if !data.achievements.is_empty() || data.supported == Some(false) {
                    return Ok(data);
                }
            }
        }
    }

    let bin = resolve_or_err(&app)?;
    let resp_res =
        client::run_json::<GameAchievementsResponse>(&bin, &["achievements", "--json", &app_name])
            .await;

    let resp = match resp_res {
        Ok(mut r) => {
            r.consolidate();
            enrich_achievements_from_metadata(&mut r, &app_name);
            r.consolidate();
            r.supported = Some(r.total_achievements > 0);
            r
        }
        Err(e) => {
            let s = e.to_string();
            // For games without achievements, legendary returns empty output, "No achievements" or a NoneType AttributeError.
            if s.contains("@t:err.emptyOutput")
                || s.contains("No achievements")
                || s.contains("AttributeError")
                || s.contains("NoneType")
            {
                let mut empty_resp = GameAchievementsResponse::default();
                empty_resp.supported = Some(false);
                empty_resp
            } else {
                return Err(fail(&app, e));
            }
        }
    };

    let _ = std::fs::create_dir_all(&cache_dir);
    if let Ok(json_str) = serde_json::to_string_pretty(&resp) {
        let _ = std::fs::write(&cache_file, json_str);
    }

    Ok(resp)
}

#[tauri::command]
pub async fn epic_get_achievements_summary(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, GameAchievementSummary>, String> {
    // Scans the achievements cache + every metadata file: keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let config = skip::default_config_dir();
        let cache_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("achievements");
        scan_achievements_summary(&config, &cache_dir)
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn scan_achievements_summary(
    config: &std::path::Path,
    cache_dir: &std::path::Path,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    use std::collections::HashMap;

    let mut out: HashMap<String, GameAchievementSummary> = HashMap::new();

    // 1. First scan legendary's own cached achievements.json file
    // (stored per namespace: e.g. "carnation", "2e92a78949e2474aa89271b8b893f3b0")
    // Values: (total_unlocked, total_xp, has_plat, base_unlocked, base_user_xp)
    let mut user_ach_map: HashMap<String, (u32, u32, bool, u32, u32)> = HashMap::new();
    let leg_ach_file = config.join("achievements.json");
    if leg_ach_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&leg_ach_file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = val.as_object() {
                    for (ns_key, data) in obj {
                        // A null entry means "never synced", not "no unlocks".
                        if data.is_null() {
                            continue;
                        }
                        let total_unlocked = data
                            .get("totalUnlocked")
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                data.get("achievementSets")
                                    .and_then(|s| s.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|x| {
                                                x.get("totalUnlocked").and_then(|u| u.as_u64())
                                            })
                                            .sum()
                                    })
                            })
                            .unwrap_or(0) as u32;

                        let total_xp = data
                            .get("totalXP")
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                data.get("achievementSets")
                                    .and_then(|s| s.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|x| {
                                                x.get("totalXP").and_then(|u| u.as_u64())
                                            })
                                            .sum()
                                    })
                            })
                            .unwrap_or(0) as u32;

                        let (base_unlocked, base_user_xp) = data
                            .get("achievementSets")
                            .and_then(|s| s.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .find(|s| {
                                        s.get("isBase")
                                            .or_else(|| s.get("is_base"))
                                            .and_then(|b| b.as_bool())
                                            .unwrap_or(false)
                                    })
                                    .map(|s| {
                                        let u = s
                                            .get("totalUnlocked")
                                            .and_then(|v| v.as_u64())
                                            .unwrap_or(0)
                                            as u32;
                                        let x =
                                            s.get("totalXP").and_then(|v| v.as_u64()).unwrap_or(0)
                                                as u32;
                                        (u, x)
                                    })
                                    .unwrap_or((0, 0))
                            })
                            .unwrap_or((0, 0));

                        let has_plat = data
                            .get("playerAwards")
                            .or_else(|| data.get("user_awards"))
                            .and_then(|a| a.as_array())
                            .map(|arr| {
                                arr.iter().any(|aw| {
                                    aw.get("awardType")
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.eq_ignore_ascii_case("PLATINUM"))
                                        .unwrap_or(false)
                                })
                            })
                            .unwrap_or(false);

                        user_ach_map.insert(
                            ns_key.to_lowercase(),
                            (
                                total_unlocked,
                                total_xp,
                                has_plat,
                                base_unlocked,
                                base_user_xp,
                            ),
                        );
                    }
                }
            }
        }
    }

    // 2. Match each game's total achievement and XP counts from the metadata folder
    let metadata_dir = config.join("metadata");
    if metadata_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(metadata_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let app_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if app_name.is_empty() {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(ach) = val.get("achievements") {
                            let total = ach
                                .get("total_achievements")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            let total_xp = ach
                                .get("total_product_xp")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            if total > 0 {
                                let ns = ach
                                    .get("namespace")
                                    .or_else(|| val.get("namespace"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&app_name)
                                    .to_lowercase();

                                let (base_total, _base_xp) = ach
                                    .get("achievement_sets")
                                    .or_else(|| ach.get("achievementSets"))
                                    .and_then(|s| s.as_array())
                                    .map(|sets| {
                                        sets.iter()
                                            .find(|s| {
                                                s.get("isBase")
                                                    .or_else(|| s.get("is_base"))
                                                    .and_then(|b| b.as_bool())
                                                    .unwrap_or(false)
                                            })
                                            .map(|s| {
                                                let cnt = s
                                                    .get("totalAchievements")
                                                    .or_else(|| s.get("total_achievements"))
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0)
                                                    as u32;
                                                let xp = s
                                                    .get("totalXP")
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0)
                                                    as u32;
                                                (cnt, xp)
                                            })
                                            .unwrap_or((0, 0))
                                    })
                                    .unwrap_or((0, 0));

                                let progress = user_ach_map
                                    .get(&ns)
                                    .or_else(|| user_ach_map.get(&app_name.to_lowercase()))
                                    .copied();
                                let (
                                    user_unlocked,
                                    user_xp,
                                    has_plat,
                                    base_unlocked,
                                    _base_user_xp,
                                ) = progress.unwrap_or((0, 0, false, 0, 0));

                                let base_plat = base_total > 0 && base_unlocked >= base_total;
                                let all_plat = total > 0 && user_unlocked >= total;
                                let is_platinum = base_plat || all_plat || has_plat;

                                out.insert(
                                    app_name.clone(),
                                    GameAchievementSummary {
                                        app_name: app_name.clone(),
                                        user_unlocked,
                                        total_achievements: total,
                                        user_xp,
                                        total_xp,
                                        is_platinum,
                                        supported: true,
                                        base_achievements: base_total,
                                        base_unlocked,
                                        progress_known: progress.is_some(),
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Also merge cache files saved on demand from the detail drawer
    if cache_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let app_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(mut data) = serde_json::from_str::<GameAchievementsResponse>(&content)
                    {
                        data.consolidate();
                        enrich_achievements_from_metadata(&mut data, &app_name);
                        data.consolidate();
                        let total = if data.total_achievements > 0 {
                            data.total_achievements
                        } else {
                            data.achievements.len() as u32
                        };
                        let is_plat = data.is_platinum;
                        out.entry(app_name.clone())
                            .and_modify(|s| {
                                s.user_unlocked = data.user_unlocked;
                                s.user_xp = data.user_xp;
                                s.is_platinum = is_plat;
                                s.base_achievements = data.base_achievements;
                                s.base_unlocked = data.base_unlocked;
                                s.progress_known = true;
                            })
                            .or_insert(GameAchievementSummary {
                                app_name,
                                user_unlocked: data.user_unlocked,
                                total_achievements: total,
                                user_xp: data.user_xp,
                                total_xp: data.total_xp,
                                is_platinum: is_plat,
                                supported: true,
                                base_achievements: data.base_achievements,
                                base_unlocked: data.base_unlocked,
                                progress_known: true,
                            });
                    }
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_scan_achievements_carnation() {
        let config = skip::default_config_dir();
        let cache_dir = std::env::temp_dir().join("test_ach_cache");
        let summaries = scan_achievements_summary(&config, &cache_dir);
        for (k, v) in &summaries {
            if v.is_platinum {
                println!("PLATINUM GAME: {} => {:?}", k, v);
            }
        }
        // Only assert when the local account actually has that cache.
        if let Some(carnation) = summaries.get("Carnation") {
            assert_eq!(carnation.total_achievements, 48);
            assert_eq!(carnation.user_unlocked, 48);
            assert_eq!(carnation.is_platinum, true);
        }
    }

    #[test]
    fn null_progress_is_unknown_until_the_cache_has_it() {
        let base = std::env::temp_dir().join(format!(
            "efxlve-ach-known-{}",
            std::process::id()
        ));
        let config = base.join("config");
        let cache_dir = base.join("achievements");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(config.join("metadata")).unwrap();
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(
            config.join("metadata").join("TestApp.json"),
            r#"{"achievements":{"total_achievements":10,"namespace":"ns-test"}}"#,
        )
        .unwrap();
        // A null legendary entry means "never synced", not "zero unlocked".
        std::fs::write(config.join("achievements.json"), r#"{"ns-test":null}"#).unwrap();

        let summaries = scan_achievements_summary(&config, &cache_dir);
        let unknown = summaries.get("TestApp").expect("metadata row");
        assert_eq!(unknown.total_achievements, 10);
        assert_eq!(unknown.user_unlocked, 0);
        assert!(!unknown.progress_known);

        std::fs::write(
            cache_dir.join("TestApp.json"),
            r#"{"achievements":[{"name":"a","unlocked":true}],"user_unlocked":1,"total_achievements":10,"supported":true}"#,
        )
        .unwrap();
        let summaries = scan_achievements_summary(&config, &cache_dir);
        let known = summaries.get("TestApp").expect("cached row");
        assert_eq!(known.user_unlocked, 1);
        assert!(known.progress_known);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[ignore = "requires live legendary binary and network"]
    fn test_run_json_achievements_carnation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bin = std::path::PathBuf::from("legendary");
            let mut resp: GameAchievementsResponse =
                client::run_json(&bin, &["achievements", "--json", "Carnation"])
                    .await
                    .expect("parse edilmeli");
            resp.consolidate();
            println!(
                "TEST RUN CARNATION: achievements.len() = {}",
                resp.achievements.len()
            );
            println!("TEST RUN CARNATION: user_unlocked = {}", resp.user_unlocked);
            assert_eq!(resp.achievements.len(), 48);
        });
    }

    #[test]
    fn test_enrich_achievements_ginger() {
        let config = skip::default_config_dir();
        if !config.join("metadata").join("Ginger.json").is_file() {
            return;
        }
        let mut resp = GameAchievementsResponse {
            achievements: vec![
                AchievementItem {
                    name: "TheTower".to_string(),
                    display_name: "".to_string(),
                    description: "".to_string(),
                    hidden: false,
                    is_base: true,
                    ..Default::default()
                },
                AchievementItem {
                    name: "BornToBeWild".to_string(),
                    display_name: "".to_string(),
                    description: "".to_string(),
                    hidden: false,
                    is_base: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        enrich_achievements_from_metadata(&mut resp, "Ginger");
        let b = resp
            .achievements
            .iter()
            .find(|a| a.name == "BornToBeWild")
            .unwrap();
        assert!(
            b.hidden,
            "BornToBeWild must be marked as a hidden achievement"
        );
        assert!(
            !b.display_name.is_empty(),
            "The name must be filled from metadata"
        );

        let t = resp
            .achievements
            .iter()
            .find(|a| a.name == "TheTower")
            .unwrap();
        assert!(t.hidden, "TheTower must be hidden");
        assert!(
            !t.is_base,
            "TheTower belongs to the Phantom Liberty DLC (is_base: false)"
        );
        assert!(
            !t.display_name.is_empty(),
            "TheTower title must not be empty"
        );
    }

    #[test]
    fn eos_log_lines_become_unlocks() {
        let text = "12:52:54:564 (00028584) > [Epic] Achievement innersanctuary unlocked at 1795081973\n\
                    13:08:21:388 (00028584) > [Epic] Achievement challengefinder unlocked at 1795082900\n\
                    [Epic] Achievement innersanctuary unlocked at 1795082999\n\
                    [Epic] Achievement not a name unlocked at 123\n";
        let unlocks = parse_eos_unlocks(text);
        assert_eq!(unlocks.get("innersanctuary"), Some(&1795082999));
        assert_eq!(unlocks.get("challengefinder"), Some(&1795082900));
        assert_eq!(unlocks.len(), 2);
    }

    #[test]
    fn eos_title_normalization_ignores_punctuation_and_apostrophes() {
        assert_eq!(
            normalize_eos_title("Marvel's Spider-Man: Miles Morales"),
            normalize_eos_title("Marvels Spider Man Miles Morales")
        );
        assert_eq!(
            normalize_eos_title("Marvel\u{2019}s Spider-Man Remastered"),
            normalize_eos_title("Marvel's Spider-Man Remastered")
        );
    }

    #[test]
    fn eos_log_is_found_by_the_documents_folder_name() {
        let base = std::env::temp_dir().join(format!("efxlve-eos-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let title = "Marvel's Spider-Man Remastered";
        let dir = base.join(title);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join(format!("{title}.log"));
        std::fs::write(
            &log,
            "[Epic] Achievement superiorspiderman unlocked at 1795085360\n",
        )
        .unwrap();

        let found = find_eos_log_in(&base, &normalize_eos_title(title)).expect("game log");
        assert_eq!(found, log);

        let _ = std::fs::remove_dir_all(&base);
    }
}
