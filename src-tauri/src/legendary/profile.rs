use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// Metadata dizininden taranan özet oyun bilgisi
struct MetaGameInfo {
    app_name: String,
    app_title: String,
    cover: Option<String>,
    total_achievements: u32,
    total_product_xp: u32,
    raw_lower: String,
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

    // İlk geçerli URL
    for img in key_images {
        if let Some(url) = img.get("url").and_then(|u| u.as_str()) {
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }

    None
}

/// Disk üzerindeki metadata/*.json dosyalarını tarar
fn scan_metadata_files(config: &Path) -> Vec<MetaGameInfo> {
    let mut list = Vec::new();
    let meta_dir = config.join("metadata");
    if !meta_dir.is_dir() {
        return list;
    }

    if let Ok(entries) = fs::read_dir(meta_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let app_name = val
                        .get("app_name")
                        .and_then(|n| n.as_str())
                        .unwrap_or_default()
                        .to_string();

                    if app_name.is_empty() {
                        continue;
                    }

                    let app_title = val
                        .get("app_title")
                        .or_else(|| val.get("title"))
                        .and_then(|t| t.as_str())
                        .unwrap_or(&app_name)
                        .to_string();

                    let cover = pick_best_cover(&val);

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

                    let raw_lower = content.to_lowercase();

                    list.push(MetaGameInfo {
                        app_name,
                        app_title,
                        cover,
                        total_achievements: total_ach,
                        total_product_xp: total_xp,
                        raw_lower,
                    });
                }
            }
        }
    }

    list
}

pub fn profile_cache_path(config: &Path) -> PathBuf {
    config.join("profile_cache.json")
}

/// Epic Games resmi GraphQL API'sinden kullanıcı profil ve başarım verilerini çeker
pub async fn fetch_player_profile(
    config: &Path,
    force_refresh: bool,
) -> Result<EpicPlayerProfile, String> {
    let cache_file = profile_cache_path(config);

    // 1. Önbellek kontrolü (force_refresh false ise ve dosya varsa anında dön)
    if !force_refresh && cache_file.is_file() {
        if let Ok(content) = fs::read_to_string(&cache_file) {
            if let Ok(prof) = serde_json::from_str::<EpicPlayerProfile>(&content) {
                return Ok(prof);
            }
        }
    }

    // 2. user.json'dan kimlik bilgilerini oku
    let user_file = config.join("user.json");
    if !user_file.is_file() {
        return Err("Epic hesabına giriş yapılmamış (user.json bulunamadı)".into());
    }

    let user_content =
        fs::read_to_string(&user_file).map_err(|e| format!("user.json okunamadı: {e}"))?;
    let user_json: serde_json::Value =
        serde_json::from_str(&user_content).map_err(|e| format!("user.json geçersiz: {e}"))?;

    let account_id = user_json
        .get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "user.json içinde account_id bulunamadı".to_string())?
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
        .ok_or_else(|| "user.json içinde access_token bulunamadı".to_string())?;

    // 3. GraphQL sorgusu hazırla
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
        .map_err(|e| format!("HTTP istemcisi oluşturulamadı: {e}"))?;

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
        .map_err(|e| format!("Epic Games GraphQL sunucusuna bağlanılamadı: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err("Epic oturum anahtarının süresi dolmuş, lütfen kütüphaneyi yenileyin veya tekrar giriş yapın.".into());
        }
        return Err(format!(
            "Epic GraphQL hatası: HTTP {} - {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Bilinmeyen hata")
        ));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| format!("GraphQL cevabı okunamadı: {e}"))?;

    let gql_resp: GqlResponse =
        serde_json::from_str(&text).map_err(|e| format!("GraphQL cevabı çözümlenemedi: {e}"))?;

    let records = gql_resp
        .data
        .and_then(|d| d.player_achievement)
        .and_then(|p| p.player_achievement_game_records)
        .and_then(|r| r.records)
        .unwrap_or_default();

    // 4. Metadata dosyalarını tara ve eşle
    let meta_games = scan_metadata_files(config);

    let mut game_records: Vec<ProfileGameRecord> = Vec::new();
    let mut total_unlocked = 0u32;
    let mut platinum_count = 0u32;
    let mut base_xp = 0u32;

    for r in records {
        let sb = r.sandbox_id.clone();
        let sb_lower = sb.to_lowercase();

        // Metadata'da en uygun oyunu ara
        let match_game = meta_games
            .iter()
            .find(|m| m.app_name.to_lowercase() == sb_lower)
            .or_else(|| meta_games.iter().find(|m| m.raw_lower.contains(&sb_lower)));

        let app_name = match_game
            .map(|m| m.app_name.clone())
            .unwrap_or_else(|| sb.clone());

        let app_title = match_game
            .map(|m| m.app_title.clone())
            .unwrap_or_else(|| sb.clone());

        let cover = match_game.and_then(|m| m.cover.clone());

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

        let mut total_ach = match_game.map(|m| m.total_achievements).unwrap_or(0);
        let mut total_prod_xp = match_game.map(|m| m.total_product_xp).unwrap_or(0);

        // Fallback: Başarım sayısı metadata'da boşsa veya 0 ise
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
        });
    }

    // Epic Games Store her Platin kupa için +250 XP bonus verir
    let total_xp = base_xp + (platinum_count * 250);

    // Oyunları sırala: Platinler ve yüksek ilerlemeliler önce, sonra XP'ye göre
    game_records.sort_by(|a, b| {
        b.is_platinum
            .cmp(&a.is_platinum)
            .then_with(|| b.unlocked_percent.cmp(&a.unlocked_percent))
            .then_with(|| b.total_xp.cmp(&a.total_xp))
            .then_with(|| a.app_title.cmp(&b.app_title))
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
    };

    // 5. Diske önbellekle
    if let Ok(serialized) = serde_json::to_string_pretty(&profile) {
        let _ = fs::write(&cache_file, serialized);
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
}
