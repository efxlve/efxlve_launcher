//! HTTP REST API client for GOG Galaxy services.
//!
//! Communicates with:
//! - `auth.gog.com` (OAuth2 token exchange and refresh)
//! - `users.gog.com` / `embed.gog.com` (user profile and fast library discovery)
//! - `galaxy-library.gog.com` (official release certificate registry)
//! - `api.gog.com` / `gamesdb.gog.com` (product details and high-resolution vertical artwork)

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde_json::Value;

use super::models::{GogAuthTokens, GogGameDetails, GogGameSummary, GogUserProfile};
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

    Ok(games)
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

    // Secondary fetch from v2 API for developer, publisher, and high-res screenshots
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
            }
        }
    }

    Ok(details)
}
