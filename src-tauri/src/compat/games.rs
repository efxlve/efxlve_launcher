//! Per-game compatibility overrides.
//!
//! The Settings page owns the default runner and layers; a single game may need
//! a different Proton build (an old title that regressed, a multiplayer title
//! with anti-cheat, or a prefix that already has its own DXVK install). This
//! file keeps only the exceptions in `<app_data>/compat/games.json`; a game
//! without an entry inherits the global settings.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::install::compat_root;
use super::launch::{valid_layer, valid_runner};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCompatConfig {
    /// `None` means "use the global runner".
    #[serde(default)]
    pub runner: Option<String>,
    #[serde(default)]
    pub runner_path: Option<String>,
    #[serde(default)]
    pub runner_tag: Option<String>,
    /// `Some([])` is an explicit "no translation layers"; `None` inherits.
    #[serde(default)]
    pub layers: Option<Vec<String>>,
}

impl GameCompatConfig {
    fn is_empty(&self) -> bool {
        self.runner.is_none()
            && self.runner_path.is_none()
            && self.runner_tag.is_none()
            && self.layers.is_none()
    }
}

fn games_file(app: &AppHandle) -> PathBuf {
    compat_root(app).join("games.json")
}

fn load_all(app: &AppHandle) -> BTreeMap<String, GameCompatConfig> {
    std::fs::read_to_string(games_file(app))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_all(app: &AppHandle, games: &BTreeMap<String, GameCompatConfig>) -> Result<(), String> {
    let path = games_file(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "@t:compat.saveFailed".to_string())?;
    }
    let text =
        serde_json::to_string_pretty(games).map_err(|_| "@t:compat.saveFailed".to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|_| "@t:compat.saveFailed".to_string())?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err("@t:compat.saveFailed".to_string());
    }
    Ok(())
}

pub fn get(app: &AppHandle, app_name: &str) -> GameCompatConfig {
    load_all(app).remove(app_name).unwrap_or_default()
}

fn clean(mut config: GameCompatConfig) -> Result<GameCompatConfig, String> {
    config.runner = config
        .runner
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    config.runner_path = config
        .runner_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    config.runner_tag = config
        .runner_tag
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(id) = config.runner.as_deref() {
        if !valid_runner(id) {
            return Err("@t:compat.unknownRunner".to_string());
        }
    }
    if let Some(path) = config.runner_path.as_deref() {
        if config.runner.is_none() || !std::path::Path::new(path).is_dir() {
            return Err("@t:compat.badRunnerPath".to_string());
        }
    }
    if let Some(layers) = config.layers.as_mut() {
        let mut clean_layers = Vec::new();
        for id in layers.drain(..) {
            if !valid_layer(&id) {
                return Err("@t:compat.unknownLayer".to_string());
            }
            if !clean_layers.contains(&id) {
                clean_layers.push(id);
            }
        }
        *layers = clean_layers;
    }
    Ok(config)
}

#[tauri::command]
pub fn compat_get_game_config(app: AppHandle, app_name: String) -> GameCompatConfig {
    get(&app, &app_name)
}

#[tauri::command]
pub fn compat_set_game_config(
    app: AppHandle,
    app_name: String,
    config: GameCompatConfig,
) -> Result<(), String> {
    if app_name.trim().is_empty() {
        return Err("@t:compat.unknownTool".to_string());
    }
    let config = clean(config)?;
    let mut games = load_all(&app);
    if config.is_empty() {
        games.remove(&app_name);
    } else {
        games.insert(app_name, config);
    }
    write_all(&app, &games)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_per_game_config_round_trips_and_rejects_unknown_values() {
        let config: GameCompatConfig = serde_json::from_str(
            r#"{"runner":"ge-proton","runnerPath":null,"runnerTag":"GE-Proton11-10","layers":["dxvk"]}"#,
        )
        .expect("config");
        assert_eq!(config.runner.as_deref(), Some("ge-proton"));
        assert_eq!(config.layers, Some(vec!["dxvk".to_string()]));

        let cleaned = clean(config).expect("valid");
        assert_eq!(cleaned.runner_tag.as_deref(), Some("GE-Proton11-10"));

        let bad = GameCompatConfig {
            runner: Some("not-a-runner".to_string()),
            ..Default::default()
        };
        assert!(clean(bad).is_err());

        let bad_layer = GameCompatConfig {
            runner: None,
            runner_path: None,
            runner_tag: None,
            layers: Some(vec!["not-a-layer".to_string()]),
        };
        assert!(clean(bad_layer).is_err());
    }

    #[test]
    fn an_empty_config_is_removed_not_written() {
        let config = GameCompatConfig::default();
        assert!(config.is_empty());
    }
}
