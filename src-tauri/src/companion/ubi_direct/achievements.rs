//! Merge the shim's local achievement state into the Connect-cache answer.
//!
//! The R1 shim rewrites `upc.json` when the game calls `UPLAY_ACH_Write` or
//! `UPLAY_ACH_EarnAchievement`. Reading that file keeps the achievement tab
//! alive after Ubisoft Connect is removed, while the catalogue (names,
//! descriptions, icons) still comes from the client cache when it exists.

use std::collections::HashMap;

use crate::companion::scan::slug;
use crate::companion::ubi_installs;
use crate::legendary::models::{AchievementItem, GameAchievementsResponse};

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalAchievement {
    id: u32,
    name: String,
    description: String,
    achieved: bool,
}

pub(crate) fn merge(
    mut data: GameAchievementsResponse,
    id: &str,
    title: &str,
) -> GameAchievementsResponse {
    let Some(record) = find_record(id, title) else {
        return data;
    };
    let local = read_local(&record);
    if local.is_empty() {
        return data;
    }
    if data.achievements.is_empty() {
        data.achievements = local
            .iter()
            .filter(|achievement| !is_placeholder(achievement) || achievement.achieved)
            .map(|achievement| AchievementItem {
                name: achievement.id.to_string(),
                display_name: achievement.name.clone(),
                description: achievement.description.clone(),
                unlocked: achievement.achieved,
                progress: if achievement.achieved { 100.0 } else { 0.0 },
                ..Default::default()
            })
            .collect();
    } else {
        let states: HashMap<u32, bool> = local
            .iter()
            .map(|achievement| (achievement.id, achievement.achieved))
            .collect();
        for item in &mut data.achievements {
            let Ok(id) = item.name.parse::<u32>() else {
                continue;
            };
            let Some(achieved) = states.get(&id) else {
                continue;
            };
            item.unlocked = *achieved;
            item.progress = if *achieved { 100.0 } else { 0.0 };
        }
    }
    data.user_unlocked = data.achievements.iter().filter(|item| item.unlocked).count() as u32;
    data.total_achievements = data.achievements.len() as u32;
    data.supported = Some(data.total_achievements > 0);
    data
}

fn is_placeholder(achievement: &LocalAchievement) -> bool {
    achievement.description.is_empty()
        && achievement.name == format!("Achievement #{}", achievement.id)
}

fn find_record(id: &str, title: &str) -> Option<ubi_installs::InstalledGame> {
    let product_id = id.parse::<u32>().ok();
    let title_key = slug(title);
    ubi_installs::load().into_iter().find(|record| {
        product_id == Some(record.product_id)
            || (record.uplay_id != 0 && product_id == Some(record.uplay_id))
            || (!title_key.is_empty() && slug(&record.name) == title_key)
    })
}

fn read_local(record: &ubi_installs::InstalledGame) -> Vec<LocalAchievement> {
    let directory = std::path::Path::new(&record.install_dir);
    let exe = directory.join(record.exe.replace('\\', std::path::MAIN_SEPARATOR_STR));
    let mut candidates = Vec::new();
    if let Some(parent) = exe.parent() {
        candidates.push(parent.join("upc.json"));
    }
    candidates.push(directory.join("upc.json"));
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let parsed = parse(&text);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    Vec::new()
}

fn parse(text: &str) -> Vec<LocalAchievement> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(rows) = value.get("Achis").and_then(|rows| rows.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("Id")?.as_u64()? as u32;
            Some(LocalAchievement {
                id,
                name: row
                    .get("Name")
                    .and_then(|name| name.as_str())
                    .unwrap_or("")
                    .to_string(),
                description: row
                    .get("Description")
                    .and_then(|description| description.as_str())
                    .unwrap_or("")
                    .to_string(),
                achieved: row
                    .get("Achieved")
                    .and_then(|achieved| achieved.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shim_achievement_list() {
        let text = r#"{
            "Achis": [
                {"Id": 1, "Name": "First", "Description": "Do it", "Achieved": true},
                {"Id": 2, "Name": "Second", "Description": "Again", "Achieved": false}
            ]
        }"#;
        let rows = parse(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, 1);
        assert!(rows[0].achieved);
        assert!(!rows[1].achieved);
        assert!(parse("{}").is_empty());
    }

    #[test]
    fn an_empty_catalogue_uses_the_local_names() {
        let local = vec![
            LocalAchievement {
                id: 1,
                name: "Achievement #1".into(),
                description: "".into(),
                achieved: false,
            },
            LocalAchievement {
                id: 2,
                name: "Achievement #2".into(),
                description: "".into(),
                achieved: true,
            },
            LocalAchievement {
                id: 7,
                name: "Local".into(),
                description: "From the shim".into(),
                achieved: false,
            },
        ];
        let visible: Vec<u32> = local
            .iter()
            .filter(|achievement| !is_placeholder(achievement) || achievement.achieved)
            .map(|row| row.id)
            .collect();
        assert_eq!(visible, vec![2, 7]);
    }
}
