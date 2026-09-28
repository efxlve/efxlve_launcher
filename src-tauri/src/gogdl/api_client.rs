//! HTTP REST API client for GOG Galaxy services.
//!
//! Communicates with:
//! - `auth.gog.com` (OAuth2 token exchange and refresh)
//! - `users.gog.com` / `embed.gog.com` (user profile and fast library discovery)
//! - `galaxy-library.gog.com` (official release certificate registry)
//! - `api.gog.com` / `gamesdb.gog.com` (product details and high-resolution vertical artwork)

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde_json::Value;

use super::models::{GogAuthTokens, GogBuildInfo, GogFriend, GogGameDetails, GogGameSummary, GogUserProfile};
use super::GogError;

pub const GOG_CLIENT_ID: &str = "46899977096215655";
pub const GOG_CLIENT_SECRET: &str =
    "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
pub const GOG_REDIRECT_URI: &str =
    "https://embed.gog.com/on_login_success?origin=client";

const APP_USER_AGENT: &str =
    "EfxlveLauncher/0.1.16 (Windows NT 10.0; Win64; x64) GOGGalaxy/2.0.71";

fn create_client() -> Result<reqwest::Client, GogError> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(APP_USER_AGENT));
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| GogError::Http(e.to_string()))
}

/// Exchanges an OAuth2 authorization code for access and refresh tokens.
pub async fn exchange_auth_code(code: &str) -> Result<GogAuthTokens, GogError> {
    let client = create_client()?;
    let url = "https://auth.gog.com/token";

    let params = [
        ("client_id", GOG_CLIENT_ID),
        ("client_secret", GOG_CLIENT_SECRET),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", GOG_REDIRECT_URI),
    ];

    let res = client
        .post(url)
        .form(&params)
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(GogError::Http(format!(
            "Failed to exchange GOG auth code: {err_text}"
        )));
    }

    let mut tokens: GogAuthTokens = res
        .json()
        .await
        .map_err(|e| GogError::ParseError(e.to_string()))?;

    // Record login timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    tokens.login_time = Some(now);

    Ok(tokens)
}

/// Refreshes expired GOG tokens using the refresh_token.
pub async fn refresh_tokens(refresh_token: &str) -> Result<GogAuthTokens, GogError> {
    let client = create_client()?;
    let url = "https://auth.gog.com/token";

    let params = [
        ("client_id", GOG_CLIENT_ID),
        ("client_secret", GOG_CLIENT_SECRET),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];

    let res = client
        .post(url)
        .form(&params)
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !res.status().is_success() {
        return Err(GogError::NotAuthenticated);
    }

    let mut tokens: GogAuthTokens = res
        .json()
        .await
        .map_err(|e| GogError::ParseError(e.to_string()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    tokens.login_time = Some(now);

    Ok(tokens)
}

/// Retrieves the logged-in GOG user profile.
pub async fn get_user_profile(access_token: &str) -> Result<GogUserProfile, GogError> {
    let client = create_client()?;
    let url = "https://embed.gog.com/userData.json";

    let res = client
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !res.status().is_success() {
        return Err(GogError::NotAuthenticated);
    }

    let val: Value = res
        .json()
        .await
        .map_err(|e| GogError::ParseError(e.to_string()))?;

    let user_id = val["userId"]
        .as_str()
        .or_else(|| val["user_id"].as_str())
        .unwrap_or_default()
        .to_string();

    let username = val["username"]
        .as_str()
        .or_else(|| val["display_name"].as_str())
        .unwrap_or("GOG User")
        .to_string();

    let avatar_url = val["avatar"]
        .as_str()
        .or_else(|| val["avatar_url"].as_str())
        .map(String::from);

    Ok(GogUserProfile {
        user_id,
        username,
        avatar_url,
    })
}

/// Fetches the user's owned GOG library.
///
/// Uses `getFilteredProducts` for efficient single-roundtrip catalogue retrieval,
/// and maps image hashes to standard GOG CDN image URLs.
pub async fn fetch_user_library(access_token: &str) -> Result<Vec<GogGameSummary>, GogError> {
    let client = create_client()?;
    let mut games = Vec::new();
    let mut page = 1;

    loop {
        let url = format!(
            "https://embed.gog.com/account/getFilteredProducts?mediaType=1&page={page}"
        );

        let res = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| GogError::Http(e.to_string()))?;

        if !res.status().is_success() {
            if page == 1 {
                return Err(GogError::NotAuthenticated);
            }
            break;
        }

        let val: Value = res
            .json()
            .await
            .map_err(|e| GogError::ParseError(e.to_string()))?;

        let products = val["products"].as_array();
        let total_pages = val["totalPages"].as_u64().unwrap_or(1);

        if let Some(items) = products {
            if items.is_empty() {
                break;
            }
            for item in items {
                let id = match item["id"].as_u64() {
                    Some(num) => num.to_string(),
                    None => item["id"].as_str().unwrap_or_default().to_string(),
                };
                if id.is_empty() {
                    continue;
                }

                let title = item["title"].as_str().unwrap_or("Unknown Game").to_string();

                // Cover art: GOG API returns protocol-relative CDN paths like
                // `//images-3.gog.com/HASH` or bare hashes.
                // - `_glx_vertical_cover.jpg` has aspect ratio ~0.71 (perfect for 3:4 portrait cards)
                // - `_product_card_v2_mobile_slider_639.jpg` has aspect ratio ~1.77 (wide banner for hero)
                let raw_img = item["image"].as_str().unwrap_or_default();
                let (cover_url, hero_url) = if raw_img.is_empty() {
                    (None, None)
                } else if raw_img.starts_with("http") {
                    (Some(raw_img.to_string()), Some(raw_img.to_string()))
                } else if raw_img.starts_with("//") {
                    // Protocol-relative URL — keep the original CDN subdomain
                    (
                        Some(format!("https:{raw_img}_glx_vertical_cover.jpg")),
                        Some(format!("https:{raw_img}_product_card_v2_mobile_slider_639.jpg")),
                    )
                } else {
                    // Bare hash — build the full CDN URL
                    let clean = raw_img.trim_start_matches('/');
                    (
                        Some(format!("https://images.gog.com/{clean}_glx_vertical_cover.jpg")),
                        Some(format!("https://images.gog.com/{clean}_product_card_v2_mobile_slider_639.jpg")),
                    )
                };

                let category = item["category"].as_str().map(String::from);

                games.push(GogGameSummary {
                    game_id: id,
                    title,
                    developer: category,
                    publisher: None,
                    is_installed: false,
                    install_path: None,
                    install_size: 0,
                    version: None,
                    cover_url,
                    hero_url,
                    description: None,
                    cloud_saves_supported: item["isGalaxyCompatible"].as_bool().unwrap_or(false),
                    dlc_count: 0,
                });
            }
        }

        if page >= total_pages {
            break;
        }
        page += 1;
    }

    // Enrich library with official vertical covers and backdrop art from GamesDB
    enrich_with_gamesdb(&mut games).await;

    Ok(games)
}

/// Enriches game summaries with authentic uncropped vertical box art and heroes from GamesDB.
pub async fn enrich_with_gamesdb(games: &mut [GogGameSummary]) {
    let client = match create_client() {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut set = tokio::task::JoinSet::new();
    for (idx, g) in games.iter().enumerate() {
        if let Some(ref c) = g.cover_url {
            if c.contains("namespace=gamesdb") {
                continue;
            }
        }
        let id = g.game_id.clone();
        let client_clone = client.clone();
        set.spawn(async move {
            let url = format!("https://gamesdb.gog.com/platforms/gog/external_releases/{id}");
            if let Ok(res) = client_clone.get(&url).send().await {
                if res.status().is_success() {
                    if let Ok(val) = res.json::<Value>().await {
                        let vert = val["game"]["vertical_cover"]["url_format"]
                            .as_str()
                            .map(|s| s.replace("{formatter}", "").replace("{ext}", "jpg"));
                        let bg = val["game"]["background"]["url_format"]
                            .as_str()
                            .map(|s| s.replace("{formatter}", "_1600").replace("{ext}", "jpg"));
                        return (idx, vert, bg);
                    }
                }
            }
            (idx, None, None)
        });
    }

    while let Some(res) = set.join_next().await {
        if let Ok((idx, vert, bg)) = res {
            if let Some(v) = vert {
                games[idx].cover_url = Some(v);
            }
            if let Some(b) = bg {
                games[idx].hero_url = Some(b);
            }
        }
    }
}

/// Fetches detailed game metadata on-demand from public GOG APIs.
pub async fn fetch_game_details(game_id: &str) -> Result<GogGameDetails, GogError> {
    let client = create_client()?;
    let product_url = format!("https://api.gog.com/products/{game_id}?expand=description");

    let res = client
        .get(&product_url)
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    let mut details = GogGameDetails {
        game_id: game_id.to_string(),
        ..Default::default()
    };

    if res.status().is_success() {
        if let Ok(val) = res.json::<Value>().await {
            details.title = val["title"].as_str().unwrap_or_default().to_string();
            details.slug = val["slug"].as_str().map(String::from);

            let desc = val["description"]["full"]
                .as_str()
                .or_else(|| val["description"].as_str())
                .unwrap_or_default();
            if !desc.is_empty() {
                details.description = Some(desc.to_string());
            }

            if let Some(bg) = val["images"]["background"].as_str() {
                if !bg.is_empty() {
                    details.hero_url = Some(if bg.starts_with("//") {
                        format!("https:{bg}")
                    } else if bg.starts_with("http") {
                        bg.to_string()
                    } else {
                        format!("https://images.gog.com/{bg}")
                    });
                }
            }
        }
    }

    // Query GamesDB for official uncropped vertical cover and high-res hero background
    let gdb_url = format!("https://gamesdb.gog.com/platforms/gog/external_releases/{game_id}");
    if let Ok(gdb_res) = client.get(&gdb_url).send().await {
        if gdb_res.status().is_success() {
            if let Ok(val) = gdb_res.json::<Value>().await {
                if let Some(vert) = val["game"]["vertical_cover"]["url_format"].as_str() {
                    details.cover_url = Some(vert.replace("{formatter}", "").replace("{ext}", "jpg"));
                }
                if let Some(bg) = val["game"]["background"]["url_format"].as_str() {
                    details.hero_url = Some(bg.replace("{formatter}", "_1600").replace("{ext}", "jpg"));
                }
            }
        }
    }

    // Secondary fetch from v2 API for developer, publisher, high-res screenshots and hardware requirements
    let v2_url = format!("https://api.gog.com/v2/games/{game_id}");
    if let Ok(v2_res) = client.get(&v2_url).send().await {
        if v2_res.status().is_success() {
            if let Ok(val) = v2_res.json::<Value>().await {
                if let Some(devs) = val["_embedded"]["developers"].as_array() {
                    if let Some(first) = devs.first().and_then(|d| d["name"].as_str()) {
                        details.developer = Some(first.to_string());
                    }
                }
                if let Some(pubs) = val["_embedded"]["publishers"].as_array() {
                    if let Some(first) = pubs.first().and_then(|p| p["name"].as_str()) {
                        details.publisher = Some(first.to_string());
                    }
                }
                if let Some(screens) = val["_embedded"]["screenshots"].as_array() {
                    let mut urls = Vec::new();
                    for s in screens {
                        if let Some(href) = s["_links"]["self"]["href"].as_str() {
                            urls.push(href.replace("{formatter}", "1600"));
                        }
                    }
                    if !urls.is_empty() {
                        details.screenshots = urls;
                    }
                }

                // Parse supported operating systems and system requirements
                if let Some(ops) = val["_embedded"]["supportedOperatingSystems"].as_array() {
                    let mut systems = Vec::new();
                    for op in ops {
                        let os_name = op["operatingSystem"]["name"].as_str().unwrap_or("windows");
                        let system_type = match os_name.to_lowercase().as_str() {
                            "osx" | "mac" | "macos" => "Mac".to_string(),
                            "linux" => "Linux".to_string(),
                            _ => "Windows".to_string(),
                        };

                        let mut min_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                        let mut rec_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                        let mut key_order: Vec<String> = Vec::new();

                        if let Some(req_groups) = op["systemRequirements"].as_array() {
                            for group in req_groups {
                                let req_type = group["type"].as_str().unwrap_or_default();
                                if let Some(reqs) = group["requirements"].as_array() {
                                    for item in reqs {
                                        let raw_name = item["name"].as_str().unwrap_or_default();
                                        let clean_name = raw_name.trim().trim_end_matches(':').trim();
                                        let title = if clean_name.is_empty() {
                                            item["id"].as_str().unwrap_or("Hardware").to_string()
                                        } else {
                                            clean_name.to_string()
                                        };
                                        let desc = item["description"].as_str().unwrap_or_default().trim().to_string();
                                        if !desc.is_empty() {
                                            if !key_order.contains(&title) {
                                                key_order.push(title.clone());
                                            }
                                            if req_type.eq_ignore_ascii_case("minimum") {
                                                min_map.insert(title, desc);
                                            } else if req_type.eq_ignore_ascii_case("recommended") {
                                                rec_map.insert(title, desc);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let mut details_items = Vec::new();
                        for title in key_order {
                            let minimum = min_map.remove(&title);
                            let recommended = rec_map.remove(&title);
                            details_items.push(crate::legendary::models::SystemDetailItem {
                                title,
                                minimum,
                                recommended,
                            });
                        }

                        if !details_items.is_empty() {
                            systems.push(crate::legendary::models::SystemRequirement {
                                system_type,
                                details: details_items,
                            });
                        }
                    }

                    if !systems.is_empty() {
                        details.requirements = Some(crate::legendary::models::GameRequirementsResponse {
                            supported: true,
                            systems,
                            languages: Vec::new(),
                            app_name: format!("gog::{game_id}"),
                            description: None,
                            short_description: None,
                            tags: Vec::new(),
                        });
                    }
                }
            }
        }
    }

    Ok(details)
}

/// Fetches user achievements for a GOG game using the official GOG Gameplay API.
pub async fn fetch_gog_achievements(
    access_token: &str,
    user_id: &str,
    game_id: &str,
) -> Result<crate::legendary::models::GameAchievementsResponse, GogError> {
    let client = create_client()?;
    let url = format!("https://gameplay.gog.com/clients/{game_id}/users/{user_id}/achievements");

    let res = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !res.status().is_success() {
        if res.status().as_u16() == 401 {
            return Err(GogError::NotAuthenticated);
        }
        return Ok(crate::legendary::models::GameAchievementsResponse {
            supported: Some(false),
            ..Default::default()
        });
    }

    let val: Value = res
        .json()
        .await
        .map_err(|e| GogError::ParseError(e.to_string()))?;

    let items = val["items"].as_array();
    let mut achievements = Vec::new();
    let mut user_unlocked = 0u32;

    if let Some(arr) = items {
        for item in arr {
            let key = item["achievement_key"].as_str().unwrap_or_default().to_string();
            let name = item["name"].as_str().unwrap_or(&key).to_string();
            let desc = item["description"].as_str().unwrap_or_default().to_string();
            let unlock_date = item["date_unlocked"].as_str().map(String::from);
            let unlocked = unlock_date.is_some();
            if unlocked {
                user_unlocked += 1;
            }
            let icon_unlocked = item["image_url_unlocked"].as_str().unwrap_or_default().to_string();
            let icon_locked = item["image_url_locked"].as_str().unwrap_or(&icon_unlocked).to_string();
            let icon_link = if unlocked { icon_unlocked } else { icon_locked };
            let rarity_val = item["rarity"].as_f64();
            let hidden = !item["visible"].as_bool().unwrap_or(true);

            achievements.push(crate::legendary::models::AchievementItem {
                name: key,
                display_name: name,
                description: desc,
                xp: 0,
                unlocked,
                progress: if unlocked { 100.0 } else { 0.0 },
                unlock_date,
                icon_id: item["achievement_id"].as_str().unwrap_or_default().to_string(),
                icon_link,
                tier: None,
                rarity: rarity_val.map(|p| crate::legendary::models::AchievementRarity { percent: Some(p) }),
                hidden,
                is_base: true,
            });
        }
    }

    let total = achievements.len() as u32;
    let completed: Vec<_> = achievements.iter().filter(|a| a.unlocked).cloned().collect();
    let uninitiated: Vec<_> = achievements.iter().filter(|a| !a.unlocked).cloned().collect();
    let is_platinum = total > 0 && user_unlocked >= total;

    Ok(crate::legendary::models::GameAchievementsResponse {
        total_achievements: total,
        user_unlocked,
        achievements,
        completed,
        uninitiated,
        is_platinum,
        supported: Some(total > 0),
        base_achievements: total,
        base_unlocked: user_unlocked,
        ..Default::default()
    })
}

/// Newest public Windows build of a product (content-system release feed).
///
/// The endpoint is public, so the update check needs no extra login. Items are
/// newest-first; generation 2 entries are preferred, legacy generation 1 entries
/// are only used when nothing newer exists.
pub async fn fetch_latest_build(game_id: &str) -> Result<Option<GogBuildInfo>, GogError> {
    let client = create_client()?;
    let url = format!(
        "https://content-system.gog.com/products/{game_id}/os/windows/builds?generation=2"
    );
    let resp = client.get(&url).send().await.map_err(|e| GogError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let val: Value = resp.json().await.map_err(|e| GogError::ParseError(e.to_string()))?;
    let Some(items) = val.get("items").and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    let mut fallback: Option<GogBuildInfo> = None;
    for item in items {
        let build_id = item.get("build_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if build_id.is_empty() {
            continue;
        }
        let build = GogBuildInfo {
            build_id,
            version_name: item
                .get("version_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            date_published: item
                .get("date_published")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        };
        // Prefer the first generation 2 build (the modern patch chain).
        if item.get("generation").and_then(|v| v.as_u64()) == Some(2) {
            return Ok(Some(build));
        }
        if fallback.is_none() {
            fallback = Some(build);
        }
    }
    Ok(fallback)
}

/// Maps a chat.gog.com friends payload to friend rows, sorted by name.
fn parse_gog_friends(val: &Value) -> Vec<GogFriend> {
    let mut friends = Vec::new();
    if let Some(items) = val.get("items").and_then(|v| v.as_array()) {
        for item in items {
            let user_id = match item.get("user_id") {
                Some(Value::String(s)) => s.clone(),
                Some(n) => n.to_string(),
                None => String::new(),
            };
            let username = item.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if user_id.is_empty() || username.is_empty() {
                continue;
            }
            let raw_avatar = item
                .get("images")
                .and_then(|i| i.get("medium"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let avatar_url = if raw_avatar.starts_with("//") {
                format!("https:{raw_avatar}")
            } else {
                raw_avatar.to_string()
            };
            friends.push(GogFriend {
                user_id,
                username,
                avatar_url,
            });
        }
    }
    friends.sort_by_key(|f| f.username.to_lowercase());
    friends
}

/// Fetches the signed-in user's GOG friends from the chat service.
pub async fn fetch_gog_friends(
    user_id: &str,
    access_token: &str,
) -> Result<Vec<GogFriend>, GogError> {
    let client = create_client()?;
    let url = format!("https://chat.gog.com/users/{user_id}/friends");
    let res = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(GogError::NotAuthenticated);
    }
    if !res.status().is_success() {
        return Ok(Vec::new());
    }

    let val: Value = res
        .json()
        .await
        .map_err(|e| GogError::ParseError(e.to_string()))?;

    Ok(parse_gog_friends(&val))
}

/// Lists which of the given user ids are online in GOG Galaxy right now.
///
/// The presence service accepts up to 250 ids per request and only returns the
/// ones that are online.
pub async fn fetch_presence(
    user_ids: &[String],
    access_token: &str,
) -> Result<Vec<String>, GogError> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let client = create_client()?;
    let mut online = Vec::new();
    for chunk in user_ids.chunks(250) {
        let url = format!("https://presence.gog.com/statuses?user_id={}", chunk.join(","));
        let res = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| GogError::Http(e.to_string()))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED
            || res.status() == reqwest::StatusCode::FORBIDDEN
        {
            return Err(GogError::NotAuthenticated);
        }
        if !res.status().is_success() {
            continue;
        }
        let val: Value = res
            .json()
            .await
            .map_err(|e| GogError::ParseError(e.to_string()))?;
        online.extend(parse_presence(&val));
    }
    Ok(online)
}

/// Reads `items[].user_id` from a presence service response.
fn parse_presence(value: &Value) -> Vec<String> {
    value
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.get("user_id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gog_friends_maps_and_sorts() {
        let val: Value = serde_json::from_str(
            r#"{
                "items": [
                    { "user_id": 7, "username": "Zeynep", "images": { "medium": "//images.gog.com/z_avm.jpg" } },
                    { "user_id": "3", "username": "ahmet", "images": { "medium": "https://images.gog.com/a_avm.jpg" } },
                    { "user_id": "", "username": "NoId" },
                    { "user_id": "9", "username": "" }
                ]
            }"#,
        )
        .unwrap();

        let friends = parse_gog_friends(&val);
        assert_eq!(friends.len(), 2);
        assert_eq!(friends[0].username, "ahmet");
        assert_eq!(friends[0].avatar_url, "https://images.gog.com/a_avm.jpg");
        assert_eq!(friends[1].username, "Zeynep");
        assert_eq!(friends[1].avatar_url, "https://images.gog.com/z_avm.jpg");
    }

    #[test]
    fn test_parse_gog_friends_empty_payload() {
        let val: Value = serde_json::from_str(r#"{ "items": [] }"#).unwrap();
        assert!(parse_gog_friends(&val).is_empty());
    }

    #[test]
    fn test_parse_presence_returns_online_ids() {
        let val: Value = serde_json::from_str(
            r#"{
                "total_count": 2,
                "limit": 250,
                "items": [
                    { "data": {}, "client_id": "46755278331571209", "user_id": "111" },
                    { "data": {}, "client_id": "46755278331571209", "user_id": "222" }
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(parse_presence(&val), vec!["111", "222"]);
    }

    #[test]
    fn test_parse_presence_empty_response() {
        let val: Value = serde_json::from_str(r#"{ "total_count": 0, "items": [] }"#).unwrap();
        assert!(parse_presence(&val).is_empty());
    }

    #[test]
    fn test_parse_gog_achievements_structure() {
        let json_str = r#"{
            "total_count": 2,
            "items": [
                {
                    "achievement_id": "1",
                    "achievement_key": "TEST_ACH_1",
                    "visible": true,
                    "name": "First Achievement",
                    "description": "Do something cool",
                    "image_url_unlocked": "https://images.gog.com/unlocked.jpg",
                    "image_url_locked": "https://images.gog.com/locked.jpg",
                    "rarity": 42.5,
                    "date_unlocked": "2023-01-01T00:00:00Z"
                },
                {
                    "achievement_id": "2",
                    "achievement_key": "TEST_ACH_2",
                    "visible": false,
                    "name": "Hidden Achievement",
                    "description": "Secret stuff",
                    "image_url_unlocked": "https://images.gog.com/unlocked2.jpg",
                    "image_url_locked": "https://images.gog.com/locked2.jpg",
                    "rarity": 1.2,
                    "date_unlocked": null
                }
            ]
        }"#;

        let val: Value = serde_json::from_str(json_str).unwrap();
        let items = val["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["name"], "First Achievement");
        assert_eq!(items[0]["date_unlocked"], "2023-01-01T00:00:00Z");
        assert_eq!(items[1]["visible"], false);
    }

    #[test]
    fn test_parse_gog_system_requirements_keys() {
        let req_json = r#"{
            "_embedded": {
                "supportedOperatingSystems": [
                    {
                        "operatingSystem": { "name": "windows" },
                        "systemRequirements": [
                            {
                                "type": "minimum",
                                "requirements": [
                                    { "id": "system", "name": "System:", "description": "Windows 10" },
                                    { "id": "processor", "name": "Processor:", "description": "Intel i5" }
                                ]
                            },
                            {
                                "type": "recommended",
                                "requirements": [
                                    { "id": "system", "name": "System:", "description": "Windows 11" },
                                    { "id": "processor", "name": "Processor:", "description": "Intel i7" }
                                ]
                            }
                        ]
                    }
                ]
            }
        }"#;

        let val: Value = serde_json::from_str(req_json).unwrap();
        let ops = val["_embedded"]["supportedOperatingSystems"].as_array().unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["operatingSystem"]["name"], "windows");
    }
}

