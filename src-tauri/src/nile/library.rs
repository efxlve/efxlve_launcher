//! Amazon Games library through the Nile CLI.
//!
//! `nile library list --json` prints the entitlements array Nile cached during
//! its last sync; installed state lives in `installed.json` next to it inside
//! the launcher-owned config directory.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::cli;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NileGame {
    /// Amazon product id (`product.id`), the id every other Nile command takes.
    pub id: String,
    pub title: String,
    /// Portrait/hero art when the entitlement carries one.
    pub art: Option<String>,
    pub installed: bool,
    pub install_path: Option<String>,
    pub version: Option<String>,
}

/// Art candidates inside `product.productDetail.details`, in preference order.
const ART_KEYS: &[&str] = &[
    "backgroundImage",
    "tallBackgroundImage",
    "heroImage",
    "coverImage",
    "iconUrl",
    "logoUrl",
];

fn pick_art(product: &Value) -> Option<String> {
    let details = &product["productDetail"]["details"];
    for key in ART_KEYS {
        if let Some(url) = details.get(*key).and_then(|v| v.as_str()) {
            if !url.trim().is_empty() {
                return Some(url.trim().to_string());
            }
        }
    }
    None
}

fn installed_index(app: &AppHandle) -> HashMap<String, Value> {
    let path = cli::config_dir(app).join("installed.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(list) = serde_json::from_str::<Vec<Value>>(&text) else {
        return HashMap::new();
    };
    list.into_iter()
        .filter_map(|game| {
            let id = game.get("id").and_then(|v| v.as_str())?.to_string();
            Some((id, game))
        })
        .collect()
}

fn parse_library(value: &Value, installed: &HashMap<String, Value>) -> Vec<NileGame> {
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };
    let mut games: Vec<NileGame> = entries
        .iter()
        .filter_map(|entry| {
            let product = &entry["product"];
            let id = product.get("id").and_then(|v| v.as_str())?;
            if id.is_empty() {
                return None;
            }
            let title = product
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let state = installed.get(id);
            Some(NileGame {
                id: id.to_string(),
                title: if title.is_empty() {
                    id.to_string()
                } else {
                    title
                },
                art: pick_art(product),
                installed: state.is_some(),
                install_path: state
                    .and_then(|s| s.get("path"))
                    .and_then(|v| v.as_str())
                    .filter(|p| !p.is_empty())
                    .map(|p| p.to_string()),
                version: state
                    .and_then(|s| s.get("version"))
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .map(|v| v.to_string()),
            })
        })
        .collect();
    games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    games
}

/// One installed game as Nile recorded it.
pub struct InstalledGame {
    pub path: String,
}

/// Installed state for one product id, straight from Nile's `installed.json`.
pub fn installed_game(app: &AppHandle, id: &str) -> Option<InstalledGame> {
    let index = installed_index(app);
    let state = index.get(id)?;
    let path = state.get("path").and_then(|v| v.as_str())?.to_string();
    if path.is_empty() {
        return None;
    }
    Some(InstalledGame { path })
}

/// Display title for one product id from the cached library.
pub fn game_title(app: &AppHandle, id: &str) -> Option<String> {
    let path = cli::config_dir(app).join("library.json");
    let text = std::fs::read_to_string(path).ok()?;
    let list: Vec<Value> = serde_json::from_str(&text).ok()?;
    list.iter().find_map(|entry| {
        let product = &entry["product"];
        if product.get("id").and_then(|v| v.as_str()) != Some(id) {
            return None;
        }
        product
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
    })
}

/// Library list, optionally refreshed from Amazon first.
#[tauri::command]
pub async fn nile_library(app: AppHandle, sync: bool) -> Result<Vec<NileGame>, String> {
    if sync {
        let out = cli::run(&app, &["library", "sync"], 300).await?;
        if !out.status.success() {
            return Err(cli::failure_message(&out));
        }
    }
    let out = cli::run(&app, &["library", "list", "--json"], 60).await?;
    let text = cli::stdout_text(&out);
    let value: Value = serde_json::from_str(&text).map_err(|_| cli::failure_message(&out))?;
    Ok(parse_library(&value, &installed_index(&app)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_library() -> Value {
        json!([
            {
                "id": "amzn1.adg.product.111",
                "product": {
                    "id": "amzn1.adg.product.111",
                    "title": "Zeta Game",
                    "productDetail": { "details": { "backgroundImage": "https://img/zeta.jpg" } }
                }
            },
            {
                "id": "amzn1.adg.product.222",
                "product": {
                    "id": "amzn1.adg.product.222",
                    "title": "Alpha Game",
                    "productDetail": { "details": { "iconUrl": "https://img/alpha.png" } }
                }
            }
        ])
    }

    #[test]
    fn library_parses_titles_art_and_install_state() {
        let mut installed = HashMap::new();
        installed.insert(
            "amzn1.adg.product.222".to_string(),
            json!({ "id": "amzn1.adg.product.222", "path": "D:\\Games\\Alpha", "version": "1.0.5" }),
        );

        let games = parse_library(&sample_library(), &installed);
        assert_eq!(games.len(), 2);
        // Sorted by title: Alpha first.
        assert_eq!(games[0].title, "Alpha Game");
        assert_eq!(games[0].art.as_deref(), Some("https://img/alpha.png"));
        assert!(games[0].installed);
        assert_eq!(games[0].install_path.as_deref(), Some("D:\\Games\\Alpha"));
        assert_eq!(games[0].version.as_deref(), Some("1.0.5"));

        assert_eq!(games[1].title, "Zeta Game");
        assert_eq!(games[1].art.as_deref(), Some("https://img/zeta.jpg"));
        assert!(!games[1].installed);
    }

    #[test]
    fn null_library_is_empty_and_art_falls_back_in_order() {
        assert!(parse_library(&Value::Null, &HashMap::new()).is_empty());
        let product = json!({
            "id": "x",
            "title": "",
            "productDetail": { "details": { "heroImage": "https://img/hero.jpg" } }
        });
        let entry = json!([{ "id": "x", "product": product }]);
        let games = parse_library(&entry, &HashMap::new());
        assert_eq!(games[0].title, "x");
        assert_eq!(games[0].art.as_deref(), Some("https://img/hero.jpg"));
    }
}
