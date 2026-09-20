//! Epic Online Services (EOS) & Epic Games Sosyal / Arkadaşlar / Overlay Modülü

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalAuthInfo {
    pub account_id: Option<String>,
    pub auth_type: Option<String>,
    pub external_display_name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpicFriend {
    pub account_id: String,
    pub display_name: String,
    pub alias: Option<String>,
    pub status: String, // "ONLINE", "AWAY", "OFFLINE"
    pub last_online: Option<String>,
    pub is_favorite: bool,
    pub mutual_count: u32,
    pub external_auths: HashMap<String, ExternalAuthInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpicSocialSummary {
    pub my_account_id: String,
    pub my_display_name: String,
    pub friends: Vec<EpicFriend>,
    pub incoming: Vec<EpicFriend>,
    pub outgoing: Vec<EpicFriend>,
    pub eos_overlay_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpicXmppCredentials {
    pub account_id: String,
    pub display_name: String,
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
struct RawFriendItem {
    #[serde(rename = "accountId")]
    account_id: String,
    alias: Option<String>,
    favorite: Option<bool>,
    mutual: Option<u32>,
    #[allow(dead_code)]
    created: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawFriendsSummary {
    friends: Option<Vec<RawFriendItem>>,
    incoming: Option<Vec<RawFriendItem>>,
    outgoing: Option<Vec<RawFriendItem>>,
}

#[derive(Debug, Deserialize)]
struct RawAccountItem {
    id: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "externalAuths")]
    external_auths: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct RawLastOnlineEntry {
    last_online: Option<String>,
}

/// user.json'dan account_id, display_name ve access_token okur
fn read_user_credentials(config_dir: &Path) -> Result<(String, String, String), String> {
    let user_file = config_dir.join("user.json");
    if !user_file.is_file() {
        return Err("Epic hesabına giriş yapılmamış (user.json bulunamadı)".into());
    }
    let content = fs::read_to_string(&user_file)
        .map_err(|e| format!("user.json okunamadı: {e}"))?;
    let val: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("user.json ayrıştırılamadı: {e}"))?;

    let account_id = val.get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "account_id bulunamadı".to_string())?
        .to_string();

    let display_name = val.get("displayName")
        .or_else(|| val.get("display_name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&account_id)
        .to_string();

    let access_token = val.get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "access_token bulunamadı".to_string())?
        .to_string();

    Ok((account_id, display_name, access_token))
}

/// Epic Games XMPP canlı sohbet bağlantısı için gereken kimlik bilgilerini döndürür
pub fn get_xmpp_credentials(config_dir: &Path) -> Result<EpicXmppCredentials, String> {
    let (account_id, display_name, access_token) = read_user_credentials(config_dir)?;
    Ok(EpicXmppCredentials {
        account_id,
        display_name,
        access_token,
    })
}

/// EOS Overlay'in sistemde yüklü ve etkin olup olmadığını denetler
pub fn check_eos_overlay_enabled() -> bool {
    // 1. Heroic overlay klasörü
    if let Ok(appdata) = std::env::var("APPDATA") {
        let heroic_overlay = PathBuf::from(appdata).join("heroic").join("tools").join("eos_overlay");
        if heroic_overlay.join("EOSOverlayRenderer-Win64-Shipping.exe").is_file() {
            return true;
        }
    }

    // 2. Epic Games varsayılan EOS klasörü
    let eos_path = PathBuf::from("C:\\Program Files (x86)\\Epic Games\\Epic Online Services\\managedArtifacts");
    if eos_path.is_dir() {
        if let Ok(entries) = fs::read_dir(&eos_path) {
            for entry in entries.flatten() {
                if entry.path().join("EOSOverlayRenderer-Win64-Shipping.exe").is_file() {
                    return true;
                }
            }
        }
    }

    false
}

/// Epic Games resmi sosyal ve arkadaş listesini çeker
pub async fn fetch_social_summary(config_dir: &Path) -> Result<EpicSocialSummary, String> {
    let (my_account_id, my_display_name, access_token) = read_user_credentials(config_dir)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP istemcisi başlatılamadı: {e}"))?;

    // 1. Arkadaşlar özetini çek
    let summary_url = format!(
        "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/{}/summary",
        my_account_id
    );

    let summary_resp = client.get(&summary_url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
        .send()
        .await
        .map_err(|e| format!("Arkadaş servisine bağlanılamadı: {e}"))?;

    if !summary_resp.status().is_success() {
        return Err(format!("Arkadaş listesi alınamadı: HTTP {}", summary_resp.status().as_u16()));
    }

    let summary_data: RawFriendsSummary = summary_resp.json().await
        .map_err(|e| format!("Arkadaş verisi çözümlenemedi: {e}"))?;

    let raw_friends = summary_data.friends.unwrap_or_default();
    let raw_incoming = summary_data.incoming.unwrap_or_default();
    let raw_outgoing = summary_data.outgoing.unwrap_or_default();

    // 2. Tüm hesap ID'lerini topla
    let mut all_account_ids: Vec<String> = Vec::new();
    for f in &raw_friends {
        all_account_ids.push(f.account_id.clone());
    }
    for f in &raw_incoming {
        all_account_ids.push(f.account_id.clone());
    }
    for f in &raw_outgoing {
        all_account_ids.push(f.account_id.clone());
    }
    all_account_ids.sort();
    all_account_ids.dedup();

    // 3. Hesap bilgilerini (Display Name, Steam, PSN vb.) toplu sorgula (35'lik parçalar halinde)
    let mut accounts_map: HashMap<String, (String, HashMap<String, ExternalAuthInfo>)> = HashMap::new();

    for chunk in all_account_ids.chunks(35) {
        let params: Vec<String> = chunk.iter().map(|id| format!("accountId={}", id)).collect();
        let query_str = params.join("&");
        let accounts_url = format!(
            "https://account-public-service-prod.ol.epicgames.com/account/api/public/account?{}",
            query_str
        );

        if let Ok(resp) = client.get(&accounts_url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(acc_items) = resp.json::<Vec<RawAccountItem>>().await {
                    for acc in acc_items {
                        let name = acc.display_name.unwrap_or_else(|| acc.id.clone());
                        let mut auths = HashMap::new();
                        if let Some(ext) = acc.external_auths {
                            for (k, v) in ext {
                                let auth_info = ExternalAuthInfo {
                                    account_id: v.get("accountId").and_then(|x| x.as_str()).map(String::from),
                                    auth_type: v.get("type").and_then(|x| x.as_str()).map(String::from),
                                    external_display_name: v.get("externalDisplayName").and_then(|x| x.as_str()).map(String::from),
                                    avatar: v.get("avatar").and_then(|x| x.as_str()).map(String::from),
                                };
                                auths.insert(k, auth_info);
                            }
                        }
                        accounts_map.insert(acc.id, (name, auths));
                    }
                }
            }
        }
    }

    // 4. Son görülme / Presence verilerini çek
    let presence_url = format!(
        "https://presence-public-service-prod.ol.epicgames.com/presence/api/v1/_/{}/last-online",
        my_account_id
    );

    let mut last_online_map: HashMap<String, String> = HashMap::new();
    if let Ok(resp) = client.get(&presence_url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(pres_data) = resp.json::<HashMap<String, Vec<RawLastOnlineEntry>>>().await {
                for (id, entries) in pres_data {
                    if let Some(first) = entries.into_iter().next() {
                        if let Some(time) = first.last_online {
                            last_online_map.insert(id, time);
                        }
                    }
                }
            }
        }
    }

    // 5. Arkadaş listesini inşa et
    let _now_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let build_friend_list = |raw_items: Vec<RawFriendItem>| -> Vec<EpicFriend> {
        let mut list = Vec::new();
        for item in raw_items {
            let (disp_name, ext_auths) = accounts_map.get(&item.account_id)
                .cloned()
                .unwrap_or_else(|| (item.alias.clone().unwrap_or_else(|| item.account_id.clone()), HashMap::new()));

            let last_online = last_online_map.get(&item.account_id).cloned();

            // Basit rfc3339 tahmini (frontend tam Date hesaplaması da yapacaktır)
            let status = if let Some(ref lo) = last_online {
                // YYYY-MM-DDTHH:MM:SS formatı kontrolü
                if lo.starts_with("202") || lo.starts_with("203") {
                    "OFFLINE".to_string() // Varsayılan OFFLINE, frontend canlı zaman farkına göre ONLINE yapacak
                } else {
                    "OFFLINE".to_string()
                }
            } else {
                "OFFLINE".to_string()
            };

            list.push(EpicFriend {
                account_id: item.account_id,
                display_name: disp_name,
                alias: item.alias,
                status,
                last_online,
                is_favorite: item.favorite.unwrap_or(false),
                mutual_count: item.mutual.unwrap_or(0),
                external_auths: ext_auths,
            });
        }

        // Sıralama: Favoriler başta, sonra ada göre
        list.sort_by(|a, b| {
            if a.is_favorite != b.is_favorite {
                return b.is_favorite.cmp(&a.is_favorite);
            }
            a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase())
        });

        list
    };

    let friends = build_friend_list(raw_friends);
    let incoming = build_friend_list(raw_incoming);
    let outgoing = build_friend_list(raw_outgoing);
    let eos_overlay_enabled = check_eos_overlay_enabled();

    Ok(EpicSocialSummary {
        my_account_id,
        my_display_name,
        friends,
        incoming,
        outgoing,
        eos_overlay_enabled,
    })
}

/// Kullanıcı adına göre Epic Games oyuncusu arar
pub async fn search_user(config_dir: &Path, display_name: &str) -> Result<Option<EpicFriend>, String> {
    let (_my_account_id, _my_display_name, access_token) = read_user_credentials(config_dir)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP istemcisi başlatılamadı: {e}"))?;

    let encoded_name: String = url::form_urlencoded::byte_serialize(display_name.trim().as_bytes()).collect();
    let url = format!(
        "https://account-public-service-prod.ol.epicgames.com/account/api/public/account/displayName/{}",
        encoded_name
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
        .send()
        .await
        .map_err(|e| format!("Oyuncu aranırken sunucuya bağlanılamadı: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(format!("Oyuncu aranamadı: HTTP {}", resp.status().as_u16()));
    }

    let acc: RawAccountItem = resp.json().await
        .map_err(|e| format!("Oyuncu yanıtı çözümlenemedi: {e}"))?;

    let name = acc.display_name.unwrap_or_else(|| acc.id.clone());
    let mut auths = HashMap::new();
    if let Some(ext) = acc.external_auths {
        for (k, v) in ext {
            let auth_info = ExternalAuthInfo {
                account_id: v.get("accountId").and_then(|x| x.as_str()).map(String::from),
                auth_type: v.get("type").and_then(|x| x.as_str()).map(String::from),
                external_display_name: v.get("externalDisplayName").and_then(|x| x.as_str()).map(String::from),
                avatar: v.get("avatar").and_then(|x| x.as_str()).map(String::from),
            };
            auths.insert(k, auth_info);
        }
    }

    Ok(Some(EpicFriend {
        account_id: acc.id,
        display_name: name,
        alias: None,
        status: "OFFLINE".to_string(),
        last_online: None,
        is_favorite: false,
        mutual_count: 0,
        external_auths: auths,
    }))
}

/// Arkadaşlık isteği gönderir veya gelen isteği kabul eder
pub async fn send_friend_request(config_dir: &Path, target_account_id: &str) -> Result<(), String> {
    let (my_account_id, _my_display_name, access_token) = read_user_credentials(config_dir)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP istemcisi başlatılamadı: {e}"))?;

    let url = format!(
        "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/{}/friends/{}",
        my_account_id,
        target_account_id.trim()
    );

    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Arkadaşlık isteği gönderilemedi: {e}"))?;

    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        return Err(format!("İstek başarısız: HTTP {}", resp.status().as_u16()));
    }

    Ok(())
}

/// Arkadaşı listeden çıkarır veya gelen isteği reddeder
pub async fn remove_friend(config_dir: &Path, target_account_id: &str) -> Result<(), String> {
    let (my_account_id, _my_display_name, access_token) = read_user_credentials(config_dir)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP istemcisi başlatılamadı: {e}"))?;

    let url = format!(
        "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1/{}/friends/{}",
        my_account_id,
        target_account_id.trim()
    );

    let resp = client.delete(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live")
        .send()
        .await
        .map_err(|e| format!("Arkadaş silinemedi: {e}"))?;

    if !resp.status().is_success() && resp.status().as_u16() != 204 {
        return Err(format!("Silme işlemi başarısız: HTTP {}", resp.status().as_u16()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_friends_summary_parsing() {
        let json_str = r#"{
            "friends": [
                {
                    "accountId": "06902f43edb4485ab30f6d4dcfd1aea8",
                    "status": "ACCEPTED",
                    "alias": "Kanka",
                    "favorite": true,
                    "mutual": 2
                }
            ],
            "incoming": [
                {
                    "accountId": "1f9aee3a1e1e40f2adbc828f2647fa4d",
                    "mutual": 0
                }
            ],
            "outgoing": []
        }"#;

        let parsed: RawFriendsSummary = serde_json::from_str(json_str).expect("parse error");
        let friends = parsed.friends.unwrap();
        assert_eq!(friends.len(), 1);
        assert_eq!(friends[0].account_id, "06902f43edb4485ab30f6d4dcfd1aea8");
        assert_eq!(friends[0].alias.as_deref(), Some("Kanka"));
        assert_eq!(friends[0].favorite, Some(true));
        assert_eq!(friends[0].mutual, Some(2));
    }

    #[test]
    fn test_raw_account_parsing() {
        let json_str = r#"[
            {
                "id": "35250b3fc23d477cabee1eebd1323b8c",
                "displayName": "Ay Gat Pala",
                "externalAuths": {
                    "psn": {
                        "accountId": "35250b3fc23d477cabee1eebd1323b8c",
                        "type": "psn",
                        "externalDisplayName": "Burakblkn"
                    }
                }
            }
        ]"#;

        let parsed: Vec<RawAccountItem> = serde_json::from_str(json_str).expect("parse error");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "35250b3fc23d477cabee1eebd1323b8c");
        assert_eq!(parsed[0].display_name.as_deref(), Some("Ay Gat Pala"));
        assert!(parsed[0].external_auths.is_some());
    }
}
