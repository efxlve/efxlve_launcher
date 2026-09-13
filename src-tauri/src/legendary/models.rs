//! `legendary ... --json` çıktılarının serde modelleri.
//!
//! Alan adları legendary'nin Python `Game`/`InstalledGame` dataclass'larıyla
//! birebir aynıdır (snake_case). Sürüm farklarına dayanıklılık için çoğu
//! alan `#[serde(default)]` ile opsiyoneldir.
//!
//! ÖNEMLİ: legendary bazı alanları açıkça `null` gönderir (örn.
//! `manifest_path: null`). `#[serde(default)]` yalnız EKSİK anahtarı
//! kurtarır; `null` için `deserialize_with = "null_string"` gerekir.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `null` → `""` (eksik anahtar zaten `default` ile `""` olur).
pub(crate) fn null_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// `null` → `0`.
pub(crate) fn null_u64<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u64>::deserialize(d)?.unwrap_or_default())
}

/// `asset_infos` içindeki platform (örn. "Windows") varlığı.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GameAsset {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub asset_id: String,
    /// Epic'teki derleme sürümü — güncelleme karşılaştırması buradan yapılır.
    #[serde(default, deserialize_with = "null_string")]
    pub build_version: String,
    #[serde(default, deserialize_with = "null_string")]
    pub catalog_item_id: String,
    #[serde(default, deserialize_with = "null_string")]
    pub label_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub namespace: String,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    #[serde(default)]
    pub sidecar_rev: i64,
}

/// `legendary list --json` dizisinin bir elemanı.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LegendaryGame {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub app_title: String,
    #[serde(default)]
    pub asset_infos: HashMap<String, GameAsset>,
    #[serde(default)]
    pub base_urls: Vec<String>,
    /// Epic katalog metadata'sı: açıklama, keyImages (kapaklar), DLC bilgisi...
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    pub sidecar: Option<Value>,
    pub achievements: Option<Value>,
    /// `list --json` her oyuna DLC listesini gömülü olarak ekler.
    #[serde(default)]
    pub dlcs: Vec<Value>,
}

/// `legendary list-installed --json` dizisinin bir elemanı.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InstalledGame {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub install_path: String,
    #[serde(default, deserialize_with = "null_string")]
    pub title: String,
    #[serde(default, deserialize_with = "null_string")]
    pub version: String,
    #[serde(default)]
    pub base_urls: Vec<String>,
    #[serde(default)]
    pub can_run_offline: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub egl_guid: String,
    #[serde(default, deserialize_with = "null_string")]
    pub executable: String,
    #[serde(default, deserialize_with = "null_u64")]
    pub install_size: u64,
    #[serde(default)]
    pub install_tags: Vec<String>,
    #[serde(default)]
    pub is_dlc: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub launch_parameters: String,
    #[serde(default, deserialize_with = "null_string")]
    pub manifest_path: String,
    #[serde(default)]
    pub needs_verification: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub platform: String,
    pub prereq_info: Option<Value>,
    pub uninstaller: Option<Value>,
    #[serde(default)]
    pub requires_ot: bool,
    pub save_path: Option<String>,
    #[serde(default)]
    pub is_preloaded: bool,
}

/// `legendary status --offline --json` çıktısı.
/// Giriş yapılmamışsa `account == "<not logged in>"` olur.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LegendaryStatus {
    #[serde(default, deserialize_with = "null_string")]
    pub account: String,
    pub games_available: u32,
    pub games_installed: u32,
    pub egl_sync_enabled: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub config_directory: String,
}

/// Başarım kademesi (bronze, silver, gold, platinum).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AchievementTier {
    #[serde(default, deserialize_with = "null_string")]
    pub name: String,
    #[serde(default, rename = "hexColor", deserialize_with = "null_string")]
    pub hex_color: String,
    #[serde(default)]
    pub min: Option<u32>,
    #[serde(default)]
    pub max: Option<u32>,
}

/// Başarım nadirlik yüzdesi.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AchievementRarity {
    #[serde(default)]
    pub percent: Option<f64>,
}

/// Tek bir başarım öğesi.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AchievementItem {
    #[serde(default, deserialize_with = "null_string")]
    pub name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub display_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub description: String,
    #[serde(default)]
    pub xp: u32,
    #[serde(default)]
    pub unlocked: bool,
    #[serde(default)]
    pub progress: f64,
    pub unlock_date: Option<String>,
    #[serde(default, deserialize_with = "null_string")]
    pub icon_id: String,
    #[serde(default, deserialize_with = "null_string")]
    pub icon_link: String,
    pub tier: Option<AchievementTier>,
    pub rarity: Option<AchievementRarity>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub is_base: bool,
}

/// Kullanıcı ödülü (örn. PLATINUM kupa).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UserAward {
    #[serde(default, rename = "awardType", deserialize_with = "null_string")]
    pub award_type: String,
    #[serde(default, rename = "unlockedDateTime", deserialize_with = "null_string")]
    pub unlocked_date_time: String,
    #[serde(default, rename = "achievementSetId", deserialize_with = "null_string")]
    pub achievement_set_id: String,
}

/// `legendary achievements --json <app>` çıktısının Rust modeli.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GameAchievementsResponse {
    #[serde(default)]
    pub achievements: Vec<AchievementItem>,
    #[serde(default)]
    pub completed: Vec<AchievementItem>,
    #[serde(default)]
    pub in_progress: Vec<AchievementItem>,
    #[serde(default)]
    pub uninitiated: Vec<AchievementItem>,
    #[serde(default)]
    pub hidden: Vec<AchievementItem>,
    #[serde(default)]
    pub user_unlocked: u32,
    #[serde(default)]
    pub user_xp: u32,
    #[serde(default)]
    pub user_awards: Vec<UserAward>,
    #[serde(default)]
    pub total_achievements: u32,
    #[serde(default, alias = "total_product_xp")]
    pub total_xp: u32,
    #[serde(default)]
    pub is_platinum: bool,
    #[serde(default)]
    pub supported: Option<bool>,
    #[serde(default)]
    pub base_achievements: u32,
    #[serde(default)]
    pub base_unlocked: u32,
    #[serde(default)]
    pub base_xp: u32,
    #[serde(default)]
    pub base_user_xp: u32,
}

impl GameAchievementsResponse {
    /// Legendary CLI `completed`, `in_progress`, `uninitiated`, `hidden` sepetlerini
    /// tek bir `achievements` listesinde birleştirir ve toplamları hesaplar.
    pub fn consolidate(&mut self) {
        if self.achievements.is_empty() {
            let mut all = Vec::new();
            all.extend(self.completed.clone());
            all.extend(self.in_progress.clone());
            all.extend(self.uninitiated.clone());
            all.extend(self.hidden.clone());
            self.achievements = all;
        }
        if self.total_achievements == 0 {
            self.total_achievements = self.achievements.len() as u32;
        }
        if self.total_xp == 0 {
            self.total_xp = self.achievements.iter().map(|a| a.xp).sum();
        }
        if self.user_unlocked == 0 {
            self.user_unlocked = self.achievements.iter().filter(|a| a.unlocked).count() as u32;
        }
        if self.user_xp == 0 {
            self.user_xp = self.achievements.iter().filter(|a| a.unlocked).map(|a| a.xp).sum();
        }

        let base_items: Vec<_> = self.achievements.iter().filter(|a| a.is_base).collect();
        self.base_achievements = base_items.len() as u32;
        self.base_unlocked = base_items.iter().filter(|a| a.unlocked).count() as u32;
        self.base_xp = base_items.iter().map(|a| a.xp).sum();
        self.base_user_xp = base_items.iter().filter(|a| a.unlocked).map(|a| a.xp).sum();

        let has_plat_award = self
            .user_awards
            .iter()
            .any(|a| a.award_type.eq_ignore_ascii_case("PLATINUM"));

        // Platin Kupa kuralı: Ana Oyun (Base Game) %100 tamamlandığında veya PLATINUM ödülü varsa verilir.
        let base_plat = self.base_achievements > 0 && self.base_unlocked >= self.base_achievements;
        let all_plat = self.total_achievements > 0 && self.user_unlocked >= self.total_achievements;
        self.is_platinum = base_plat || all_plat || has_plat_award;
    }
}

/// Kütüphane kartları için hafif başarım özeti.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GameAchievementSummary {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default)]
    pub user_unlocked: u32,
    #[serde(default)]
    pub total_achievements: u32,
    #[serde(default)]
    pub user_xp: u32,
    #[serde(default)]
    pub total_xp: u32,
    #[serde(default)]
    pub is_platinum: bool,
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub base_achievements: u32,
    #[serde(default)]
    pub base_unlocked: u32,
}

/// Epic Games Store sistem gereksinimi öğesi (OS, Processor, Memory, Storage vb.)
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemDetailItem {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub minimum: Option<String>,
    #[serde(default)]
    pub recommended: Option<String>,
}

/// Epic Games Store platform sistem gereksinimi (Windows, Mac)
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemRequirement {
    #[serde(default, rename = "systemType")]
    pub system_type: String,
    #[serde(default)]
    pub details: Vec<SystemDetailItem>,
}

/// Frontend'e dönülen oyun sistem gereksinimleri yanıtı
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameRequirementsResponse {
    pub supported: bool,
    pub systems: Vec<SystemRequirement>,
    pub languages: Vec<String>,
    pub app_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gerçek `list-installed --json` çıktısı: manifest_path null gelir.
    /// (Hata: "invalid type: null, expected a string at line 1 column 753")
    #[test]
    fn installed_with_nulls_parses() {
        let json = r#"[{
            "app_name": "19927295d6e3467887d4e830d8c85963",
            "install_path": "C:\\Games\\AbsoluteDrift",
            "title": "Absolute Drift",
            "version": "Win_202306231055",
            "manifest_path": null,
            "save_path": null,
            "install_size": 374178085
        }]"#;
        let v: Vec<InstalledGame> = serde_json::from_str(json).expect("parse edilmeli");
        assert_eq!(v[0].manifest_path, "");
        assert_eq!(v[0].install_size, 374178085);
        assert_eq!(v[0].platform, "");
    }

    #[test]
    fn achievements_json_parses() {
        let json = r##"{
            "achievements": [
                {
                    "name": "01",
                    "is_base": true,
                    "hidden": false,
                    "xp": 10,
                    "unlocked": true,
                    "progress": 1.0,
                    "unlock_date": "2023-11-20T18:42:10Z",
                    "display_name": "Işığı Takip Et",
                    "description": "Işık eğitimi dersini geçtin.",
                    "icon_id": "icon1.png",
                    "icon_link": "https://cdn.example.com/icon1.png",
                    "tier": { "name": "bronze", "hexColor": "#CA512B" },
                    "rarity": { "percent": 82.5 }
                }
            ],
            "hidden": [],
            "user_unlocked": 1,
            "user_xp": 10,
            "user_awards": [
                {
                    "awardType": "PLATINUM",
                    "unlockedDateTime": "2026-07-15T09:38:26.928Z",
                    "achievementSetId": "8npika2"
                }
            ]
        }"##;
        let res: GameAchievementsResponse = serde_json::from_str(json).expect("başarımlar parse edilmeli");
        assert_eq!(res.user_unlocked, 1);
        assert_eq!(res.user_xp, 10);
        assert_eq!(res.achievements.len(), 1);
        assert_eq!(res.achievements[0].display_name, "Işığı Takip Et");
        assert_eq!(res.achievements[0].unlocked, true);
        assert_eq!(res.achievements[0].tier.as_ref().unwrap().name, "bronze");
        assert_eq!(res.achievements[0].tier.as_ref().unwrap().hex_color, "#CA512B");
        assert_eq!(res.achievements[0].rarity.as_ref().unwrap().percent, Some(82.5));
        assert_eq!(res.user_awards.len(), 1);
        assert_eq!(res.user_awards[0].award_type, "PLATINUM");
    }

    #[test]
    fn test_legendary_achievements_completed_parses() {
        let json = r##"{
            "total_achievements": 48,
            "total_product_xp": 1000,
            "platinum_rarity": { "percent": 1 },
            "completed": [
                {
                    "name": "RB6X_Ach_1",
                    "is_base": true,
                    "hidden": false,
                    "xp": 5,
                    "unlocked": true,
                    "progress": 1.0,
                    "unlock_date": "2026-07-15 09:38:23.571000+00:00",
                    "display_name": "Hey Gidi SAL Günleri",
                    "description": "Kılavuz Saldıran ile 10 raunt oyna.",
                    "icon_id": "TR_01.png",
                    "icon_link": "https://shared-static-prod.epicgames.com/epic-achievements/icons/06fcebbb85a5388e7541ef4bcf09ee9f",
                    "tier": { "hexColor": "#CA512B", "max": 45, "min": 0, "name": "bronze" },
                    "rarity": { "percent": 73 }
                }
            ],
            "in_progress": [],
            "uninitiated": [],
            "hidden": [],
            "user_unlocked": 48,
            "user_xp": 1000,
            "user_awards": [
                {
                    "awardType": "PLATINUM",
                    "unlockedDateTime": "2026-07-15T09:38:26.928Z",
                    "achievementSetId": "8npika2"
                }
            ]
        }"##;
        let mut res: GameAchievementsResponse = serde_json::from_str(json).expect("legendary json parse edilmeli");
        res.consolidate();
        assert_eq!(res.total_achievements, 48);
        assert_eq!(res.total_xp, 1000);
        assert_eq!(res.user_unlocked, 48);
        assert_eq!(res.user_xp, 1000);
        assert_eq!(res.achievements.len(), 1);
        assert_eq!(res.achievements[0].display_name, "Hey Gidi SAL Günleri");
        assert_eq!(res.achievements[0].unlocked, true);
        assert_eq!(res.achievements[0].tier.as_ref().unwrap().name, "bronze");
        assert_eq!(res.achievements[0].tier.as_ref().unwrap().hex_color, "#CA512B");
        assert_eq!(res.achievements[0].rarity.as_ref().unwrap().percent, Some(73.0));
        assert_eq!(res.is_platinum, true);
    }
}
