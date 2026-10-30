//! The public Game Pass PC catalog.
//!
//! Two read-only Microsoft endpoints, neither needing an account: the SIGL list
//! names the product ids on the plan, and the display catalog turns an id into
//! a title, art and the package family name the library keys on. No licence and
//! no package content is involved, so the same code runs signed out.
//!
//! Both endpoints are unmetered, so the answer is cached in memory and on disk
//! for six hours. If Microsoft retires a URL the call answers empty and the
//! page shows its retry state.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// "All PC Games": the rail the Xbox app shows for PC Game Pass.
const SIGL: &str = "609d944c-d395-4c0a-9ea4-e9f39b52c1ad";
const SIGL_URL: &str = "https://catalog.gamepass.com/sigls/v2";
const CATALOG_URL: &str = "https://displaycatalog.mp.microsoft.com/v7.0/products";
/// The store answers twenty ids per request; a larger batch is rejected.
const CHUNK: usize = 20;
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
const CACHE_FILE: &str = "companion_xbox_gamepass.json";

/// One title on the plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePassTitle {
    pub product_id: String,
    pub title: String,
    pub publisher: String,
    pub developer: String,
    pub poster: String,
    pub hero: String,
    /// The package the library and the installer both use. Empty when the
    /// title ships through another client (EA Play titles, mostly).
    pub pfn: String,
}

static CACHE: Mutex<Option<(Instant, Vec<GamePassTitle>)>> = Mutex::new(None);

#[derive(Serialize, Deserialize)]
struct DiskCache {
    fetched: u64,
    titles: Vec<GamePassTitle>,
}

pub(crate) async fn catalog() -> Vec<GamePassTitle> {
    if let Ok(guard) = CACHE.lock() {
        if let Some((at, titles)) = guard.as_ref() {
            if at.elapsed() < TTL && !titles.is_empty() {
                return titles.clone();
            }
        }
    }
    if let Some(titles) = read_disk() {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((Instant::now(), titles.clone()));
        }
        return titles;
    }
    let fetched = fetch().await.unwrap_or_default();
    if fetched.is_empty() {
        return Vec::new();
    }
    write_disk(&fetched);
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), fetched.clone()));
    }
    fetched
}

async fn fetch() -> Result<Vec<GamePassTitle>, String> {
    let client = reqwest::Client::builder()
        .user_agent("efxlve-launcher")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let body = client
        .get(SIGL_URL)
        .query(&[("id", SIGL), ("language", "en-US"), ("market", "US")])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let ids = ids_from_sigl(&body);
    if ids.is_empty() {
        return Err("The Game Pass list answered nothing".into());
    }
    // The store answers one batch at a time and each batch costs about a
    // second, so the requests overlap: the whole catalog lands in a few
    // seconds instead of half a minute.
    let mut chunks: Vec<String> = ids.chunks(CHUNK).map(|chunk| chunk.join(",")).collect();
    let mut titles = Vec::new();
    let mut running = tokio::task::JoinSet::new();
    loop {
        while running.len() < 10 {
            let Some(joined) = chunks.pop() else {
                break;
            };
            let client = client.clone();
            running.spawn(async move { fetch_chunk(&client, &joined).await });
        }
        let Some(joined) = running.join_next().await else {
            break;
        };
        if let Ok(Ok(mut rows)) = joined {
            titles.append(&mut rows);
        }
    }
    titles.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    titles.dedup_by(|a, b| a.product_id == b.product_id);
    Ok(titles)
}

async fn fetch_chunk(
    client: &reqwest::Client,
    joined: &str,
) -> Result<Vec<GamePassTitle>, String> {
    let body = client
        .get(CATALOG_URL)
        .query(&[
            ("bigIds", joined),
            ("market", "US"),
            ("languages", "en-us"),
            ("fieldsTemplate", "details"),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    Ok(titles_from_products(&body))
}

/// Product ids of the SIGL answer. The first row is the rail's own description;
/// the rest are `{"id":"9N..."}` entries, sometimes interleaved with banners.
fn ids_from_sigl(text: &str) -> Vec<String> {
    let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(text) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        // Store product ids are twelve characters and start with a 9.
        if id.len() != 12 || !id.starts_with('9') {
            continue;
        }
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn titles_from_products(text: &str) -> Vec<GamePassTitle> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(products) = value.get("Products").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let mut titles = Vec::new();
    for product in products {
        let product_id = product
            .get("ProductId")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if product_id.is_empty() {
            continue;
        }
        let localized = product
            .get("LocalizedProperties")
            .and_then(|value| value.as_array())
            .and_then(|rows| rows.first());
        let title = localized
            .and_then(|row| row.get("ProductTitle"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let text_of = |key: &str| {
            localized
                .and_then(|row| row.get(key))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string()
        };
        titles.push(GamePassTitle {
            product_id,
            title,
            publisher: text_of("PublisherName"),
            developer: text_of("DeveloperName"),
            poster: image(localized, &["Poster", "BoxArt", "FeaturePromotionalSquareArt"]),
            hero: image(localized, &["SuperHeroArt", "TitledHeroArt", "BrandedKeyArt"]),
            pfn: package_family(product),
        });
    }
    titles
}

/// First image whose purpose is in `wanted`, as an absolute URL.
fn image(localized: Option<&serde_json::Value>, wanted: &[&str]) -> String {
    let Some(images) = localized
        .and_then(|row| row.get("Images"))
        .and_then(|value| value.as_array())
    else {
        return String::new();
    };
    for purpose in wanted {
        for entry in images {
            if entry.get("ImagePurpose").and_then(|value| value.as_str()) != Some(purpose) {
                continue;
            }
            let uri = entry.get("Uri").and_then(|value| value.as_str()).unwrap_or_default();
            if uri.is_empty() {
                continue;
            }
            // The catalog writes protocol-relative Store CDN URLs.
            return if let Some(rest) = uri.strip_prefix("//") {
                format!("https://{rest}")
            } else {
                uri.to_string()
            };
        }
    }
    String::new()
}

fn package_family(product: &serde_json::Value) -> String {
    let Some(skus) = product
        .get("DisplaySkuAvailabilities")
        .and_then(|value| value.as_array())
    else {
        return String::new();
    };
    for sku in skus {
        let Some(packages) = sku
            .get("Sku")
            .and_then(|sku| sku.get("Properties"))
            .and_then(|properties| properties.get("Packages"))
            .and_then(|value| value.as_array())
        else {
            continue;
        };
        for package in packages {
            if let Some(pfn) = package.get("PackageFamilyName").and_then(|value| value.as_str()) {
                if !pfn.is_empty() {
                    return pfn.to_string();
                }
            }
        }
    }
    String::new()
}

fn cache_path() -> std::path::PathBuf {
    super::accounts::data_dir().join(CACHE_FILE)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn read_disk() -> Option<Vec<GamePassTitle>> {
    let text = std::fs::read_to_string(cache_path()).ok()?;
    let cache: DiskCache = serde_json::from_str(&text).ok()?;
    let age = now_secs().saturating_sub(cache.fetched);
    if cache.titles.is_empty() || age > TTL.as_secs() {
        return None;
    }
    Some(cache.titles)
}

fn write_disk(titles: &[GamePassTitle]) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cache = DiskCache {
        fetched: now_secs(),
        titles: titles.to_vec(),
    };
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sigl_answer_yields_product_ids_only() {
        let body = r#"[
          {"siglId":"609d944c","title":"All PC Games","description":"Explore every game"},
          {"id":"9NPDN9R45JX4"},
          {"id":"9P8LR42PTRGJ"},
          {"id":"9NPDN9R45JX4"},
          {"id":"BRG51C5MWFSG"},
          {"id":""}
        ]"#;
        // The rail description is not a product and duplicates collapse.
        assert_eq!(ids_from_sigl(body), vec!["9NPDN9R45JX4", "9P8LR42PTRGJ"]);
        assert!(ids_from_sigl("not json").is_empty());
    }

    #[test]
    fn a_store_product_becomes_a_catalog_row() {
        let body = r#"{"Products":[{
          "ProductId":"9NPDN9R45JX4",
          "LocalizedProperties":[{
            "ProductTitle":"1000xRESIST",
            "PublisherName":"Fellow Traveller",
            "DeveloperName":"sunset visitor",
            "Images":[
              {"ImagePurpose":"BoxArt","Uri":"//store-images.s-microsoft.com/box.png"},
              {"ImagePurpose":"Poster","Uri":"//store-images.s-microsoft.com/poster.png"},
              {"ImagePurpose":"SuperHeroArt","Uri":"https://cdn.example/hero.png"}
            ]
          }],
          "DisplaySkuAvailabilities":[{"Sku":{"Properties":{"Packages":[
            {"PackageFamilyName":"SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0"}
          ]}}}]
        }]}"#;
        let titles = titles_from_products(body);
        assert_eq!(titles.len(), 1);
        let title = &titles[0];
        assert_eq!(title.product_id, "9NPDN9R45JX4");
        assert_eq!(title.title, "1000xRESIST");
        assert_eq!(title.publisher, "Fellow Traveller");
        // Poster wins over BoxArt, and protocol-relative URLs become absolute.
        assert_eq!(title.poster, "https://store-images.s-microsoft.com/poster.png");
        assert_eq!(title.hero, "https://cdn.example/hero.png");
        assert_eq!(
            title.pfn,
            "SurpriseAttackPtyLtd.1000xResist_8k24hnfn3vvj0"
        );
    }

    #[test]
    fn a_title_without_a_store_package_keeps_an_empty_pfn() {
        let body = r#"{"Products":[{
          "ProductId":"9P698GM5GR3W",
          "LocalizedProperties":[{"ProductTitle":"A Way Out"}],
          "DisplaySkuAvailabilities":[{"Sku":{"Properties":{"Packages":[{}]}}}]
        }]}"#;
        let titles = titles_from_products(body);
        assert_eq!(titles.len(), 1);
        assert!(titles[0].pfn.is_empty());
        assert!(titles[0].poster.is_empty());
    }

    /// The live endpoints are the only part that needs the network; run
    /// manually (`cargo test -- --ignored --nocapture`) to see the real list.
    #[tokio::test]
    #[ignore = "reads the live Microsoft catalog; run manually"]
    async fn the_live_catalog_answers_pc_titles() {
        let titles = fetch().await.expect("the catalog should answer");
        assert!(titles.len() > 100, "only {} titles", titles.len());
        let with_package = titles.iter().filter(|title| !title.pfn.is_empty()).count();
        assert!(with_package > titles.len() / 2, "only {with_package} carry a package");
        for title in titles.iter().take(5) {
            println!(
                "{} | {} | {} | {}",
                title.product_id, title.title, title.publisher, title.pfn
            );
        }
    }
}
