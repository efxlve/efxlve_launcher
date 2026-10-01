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

                                let (
                                    user_unlocked,
                                    user_xp,
                                    has_plat,
                                    base_unlocked,
                                    _base_user_xp,
                                ) = user_ach_map
                                    .get(&ns)
                                    .or_else(|| user_ach_map.get(&app_name.to_lowercase()))
                                    .copied()
                                    .unwrap_or((0, 0, false, 0, 0));

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
        if let Some(carnation) = summaries.get("Carnation") {
            assert_eq!(carnation.total_achievements, 48);
            assert_eq!(carnation.user_unlocked, 48);
            assert_eq!(carnation.is_platinum, true);
        }
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
}
