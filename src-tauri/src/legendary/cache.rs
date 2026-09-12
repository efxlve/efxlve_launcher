//! Heroic deseni: kütüphane ÖNCE yerelden okunur, ağ senkronu arka plandadır.
//!
//! `metadata/*.json` + `installed.json` + `user.json` doğrudan parse edilir;
//! böylece Epic API'si aksasa bile arayüz önbelleği gösterir.
//! `list --json` çıktısıyla disk formatı aynıdır (`Game.__dict__`).

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use super::models::{InstalledGame, LegendaryGame};

#[derive(Debug, Clone, Default, Deserialize)]
struct UserFile {
    // DİKKAT: user.json anahtarları snake_case'dir (account_id),
    // yanlış rename + #[serde(default)] sessizce boş string verir!
    #[serde(default)]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
}

/// Giriş yapılmışsa (görünen ad, account_id); profil URL'si id'den kurulur:
/// `https://store.epicgames.com/u/<account_id>`
pub fn read_user(config: &Path) -> Option<(String, Option<String>)> {
    let text = std::fs::read_to_string(config.join("user.json")).ok()?;
    let u: UserFile = serde_json::from_str(&text).ok()?;
    let name = u.display_name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let id = u.account_id.trim().to_string();
    Some((name, if id.is_empty() { None } else { Some(id) }))
}

/// Önbellekteki tüm oyun metadataları (bozuk dosyalar atlanır).
pub fn read_cached_games(config: &Path) -> Vec<LegendaryGame> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(config.join("metadata")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(g) = serde_json::from_str::<LegendaryGame>(&text) {
                if !g.app_name.is_empty() {
                    out.push(g);
                }
            }
        }
    }
    out.sort_by(|a, b| {
        a.app_title
            .to_lowercase()
            .cmp(&b.app_title.to_lowercase())
    });
    out
}

/// Kurulu oyunlar (`installed.json` yoksa boş liste).
pub fn read_installed(config: &Path) -> Vec<InstalledGame> {
    let Ok(text) = std::fs::read_to_string(config.join("installed.json")) else {
        return Vec::new();
    };
    let map: HashMap<String, InstalledGame> = serde_json::from_str(&text).unwrap_or_default();
    let mut v: Vec<_> = map.into_values().collect();
    v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// user.json GERÇEK anahtar düzenini kullanır (snake_case!).
    /// `rename = "accountId"` gibi bir hata sessizce boş id üretirdi.
    const SAMPLE_USER: &str = r#"{
        "account_id": "4cff91c2292944e9a8548f46a1c95ef0",
        "displayName": "Efxlve",
        "app": "EpicGamesLauncher"
    }"#;

    #[test]
    fn parses_user_display_name_and_id() {
        let u: UserFile = serde_json::from_str(SAMPLE_USER).expect("parse edilmeli");
        assert_eq!(u.display_name, "Efxlve");
        assert_eq!(u.account_id, "4cff91c2292944e9a8548f46a1c95ef0");
    }
}
