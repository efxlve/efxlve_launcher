//! Weekly Epic free games via the public store backend.
//!
//! No authentication is required. The endpoint returns every element that has a
//! promotion; the truly free ones are the entries whose current price is 0 (or
//! that have an upcoming promotion window).

use serde::Serialize;
use serde_json::Value;

const FREE_GAMES_URL: &str = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeGame {
    pub title: String,
    pub id: String,
    pub namespace: String,
    pub cover: String,
    pub slug: String,
    pub description: String,
    pub upcoming: bool,
    pub start: String,
    pub end: String,
    pub mobile: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeGamesData {
    pub current: Vec<FreeGame>,
    pub upcoming: Vec<FreeGame>,
}

fn first_image(el: &Value) -> String {
    let images = match el.get("keyImages").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return String::new(),
    };
    for wanted in ["OfferImageWide", "OfferImageTall", "Thumbnail"] {
        for img in images {
            if img.get("type").and_then(|t| t.as_str()) == Some(wanted) {
                if let Some(url) = img.get("url").and_then(|u| u.as_str()) {
                    return url.to_string();
                }
            }
        }
    }
    String::new()
}

fn slug_of(el: &Value) -> String {
    if let Some(s) = el
        .get("offerMappings")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.get("pageSlug"))
        .and_then(|s| s.as_str())
    {
        return s.to_string();
    }
    el.get("catalogNs")
        .and_then(|v| v.get("mappings"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.get("pageSlug"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

fn is_mobile_only(el: &Value) -> bool {
    let title = el
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if title == "monument valley" || title == "monument valley 2" {
        return true;
    }

    let mut markers = String::new();
    if let Some(attrs) = el.get("customAttributes").and_then(|v| v.as_array()) {
        for attr in attrs {
            markers.push_str(attr.get("key").and_then(|v| v.as_str()).unwrap_or(""));
            markers.push(' ');
            markers.push_str(attr.get("value").and_then(|v| v.as_str()).unwrap_or(""));
            markers.push(' ');
        }
    }
    if let Some(categories) = el.get("categories").and_then(|v| v.as_array()) {
        for category in categories {
            markers.push_str(category.get("path").and_then(|v| v.as_str()).unwrap_or(""));
            markers.push(' ');
        }
    }
    let markers = markers.to_lowercase();
    let mobile = markers.contains("android") || markers.contains("ios") || markers.contains("mobile");
    let pc = markers.contains("windows") || markers.contains("pc") || markers.contains("mac") || markers.contains("linux");
    mobile && !pc
}

/// Reads the earliest start/end window from all promotion groups.
fn first_offer_window(offers: &Value) -> (String, String) {
    let mut selected: Option<(String, String)> = None;
    if let Some(groups) = offers.as_array() {
        for group in groups {
            let Some(promotions) = group.get("promotionalOffers").and_then(|v| v.as_array()) else {
                continue;
            };
            for offer in promotions {
                let start = offer.get("startDate").and_then(|v| v.as_str()).unwrap_or("");
                let end = offer.get("endDate").and_then(|v| v.as_str()).unwrap_or("");
                if start.is_empty() {
                    continue;
                }
                if selected.as_ref().map_or(true, |(current, _)| start < current.as_str()) {
                    selected = Some((start.to_string(), end.to_string()));
                }
            }
        }
    }
    selected.unwrap_or_default()
}

/// Parses the store response into current and upcoming free games.
fn parse_free_games(json: &Value) -> FreeGamesData {
    let mut out = FreeGamesData::default();
    let elements = json
        .get("data")
        .and_then(|d| d.get("Catalog"))
        .and_then(|c| c.get("searchStore"))
        .and_then(|s| s.get("elements"))
        .and_then(|e| e.as_array());
    let Some(elements) = elements else {
        return out;
    };

    for el in elements {
        let title = el.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let is_official_freegame = el
            .get("categories")
            .and_then(|v| v.as_array())
            .is_some_and(|categories| {
                categories.iter().any(|category| {
                    category.get("path").and_then(|path| path.as_str()) == Some("freegames")
                })
            });
        let offer_type = el.get("offerType").and_then(|v| v.as_str()).unwrap_or("");
        let is_add_on = offer_type.eq_ignore_ascii_case("ADD_ON")
            || el.get("categories").and_then(|v| v.as_array()).is_some_and(|categories| {
                categories.iter().any(|category| {
                    category
                        .get("path")
                        .and_then(|path| path.as_str())
                        .is_some_and(|path| path == "addons" || path.starts_with("addons/"))
                })
            });
        if !is_official_freegame || is_add_on {
            continue;
        }
        let promotions = el.get("promotions");
        let current_offers = promotions
            .and_then(|p| p.get("promotionalOffers"))
            .cloned()
            .unwrap_or(Value::Null);
        let upcoming_offers = promotions
            .and_then(|p| p.get("upcomingPromotionalOffers"))
            .cloned()
            .unwrap_or(Value::Null);

        let discount_price = el
            .get("price")
            .and_then(|p| p.get("totalPrice"))
            .and_then(|t| t.get("discountPrice"))
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);

        let base = FreeGame {
            title,
            id: el.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            namespace: el
                .get("namespace")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            cover: first_image(el),
            slug: slug_of(el),
            description: el
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            upcoming: false,
            start: String::new(),
            end: String::new(),
            mobile: is_mobile_only(el),
        };

        // Currently free: the promotion is live and the price is 0.
        if discount_price == 0 && current_offers.as_array().is_some_and(|a| !a.is_empty()) {
            let (start, end) = first_offer_window(&current_offers);
            out.current.push(FreeGame {
                start,
                end,
                ..base
            });
            continue;
        }

        // Upcoming: a promotion window is scheduled.
        if upcoming_offers.as_array().is_some_and(|a| !a.is_empty()) {
            let (start, end) = first_offer_window(&upcoming_offers);
            out.upcoming.push(FreeGame {
                upcoming: true,
                start,
                end,
                ..base
            });
        }
    }

    out.current.sort_by(|a, b| a.end.cmp(&b.end));
    out.upcoming.sort_by(|a, b| a.start.cmp(&b.start));
    out
}

#[tauri::command]
pub async fn epic_free_games(locale: String, country: String) -> Result<FreeGamesData, String> {
    let locale = if locale.trim().is_empty() {
        "en-US".to_string()
    } else {
        locale
    };
    let country = if country.trim().is_empty() {
        "US".to_string()
    } else {
        country
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(FREE_GAMES_URL)
        .query(&[
            ("locale", locale.as_str()),
            ("country", country.as_str()),
            ("allowCountries", country.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "@t:free.networkError".to_string())?;
    let json: Value = resp
        .json()
        .await
        .map_err(|_| "@t:free.networkError".to_string())?;
    Ok(parse_free_games(&json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn element(title: &str, discount_price: i64, has_current: bool, has_upcoming: bool) -> Value {
        let current = if has_current {
            json!([{ "promotionalOffers": [{ "startDate": "2026-09-17T15:00:00.000Z", "endDate": "2026-09-24T15:00:00.000Z" }] }])
        } else {
            json!([])
        };
        let upcoming = if has_upcoming {
            json!([{ "promotionalOffers": [{ "startDate": "2026-09-24T15:00:00.000Z", "endDate": "2026-10-01T15:00:00.000Z" }] }])
        } else {
            json!([])
        };
        json!({
            "title": title,
            "offerType": "BASE_GAME",
            "id": "id-1",
            "namespace": "ns-1",
            "description": "desc",
            "keyImages": [
                { "type": "OfferImageWide", "url": "https://cdn.example/wide.jpg" },
                { "type": "Thumbnail", "url": "https://cdn.example/thumb.jpg" }
            ],
            "offerMappings": [{ "pageSlug": "some-slug" }],
            "price": { "totalPrice": { "discountPrice": discount_price } },
            "promotions": { "promotionalOffers": current, "upcomingPromotionalOffers": upcoming }
            ,"categories": [{ "path": "freegames" }, { "path": "games/edition/base" }]
        })
    }

    fn wrap(elements: Vec<Value>) -> Value {
        json!({ "data": { "Catalog": { "searchStore": { "elements": elements } } } })
    }

    #[test]
    fn separates_current_and_upcoming_free_games() {
        let json = wrap(vec![
            element("Free Now", 0, true, false),
            element("Coming Soon", 2500, false, true),
            element("Just On Sale", 13599, true, false),
            element("Not A Game", 0, false, false),
        ]);
        let data = parse_free_games(&json);
        assert_eq!(data.current.len(), 1);
        assert_eq!(data.current[0].title, "Free Now");
        assert_eq!(data.current[0].cover, "https://cdn.example/wide.jpg");
        assert_eq!(data.current[0].slug, "some-slug");
        assert_eq!(data.current[0].end, "2026-09-24T15:00:00.000Z");
        assert!(!data.current[0].upcoming);

        assert_eq!(data.upcoming.len(), 1);
        assert_eq!(data.upcoming[0].title, "Coming Soon");
        assert!(data.upcoming[0].upcoming);
    }

    #[test]
    fn empty_response_yields_no_games() {
        let data = parse_free_games(&json!({}));
        assert!(data.current.is_empty());
        assert!(data.upcoming.is_empty());
    }
}
