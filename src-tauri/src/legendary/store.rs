//! Efxlve Mağaza — Epic Games Store veri katmanı.
//!
//! Veri kaynakları (öncelik sırasıyla):
//! 1. Akamai CDN (ücretsiz oyunlar, ürün içeriği)
//! 2. Epic Launcher GraphQL (katalog arama, fiyatlar)
//! 3. EGData.app (fallback arama)
//!
//! İstek listesi Epic GraphQL + OAuth Bearer token gerektirir (user.json).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// ─── Sabitler ───────────────────────────────────────────────────────

const EPIC_LAUNCHER_UA: &str =
    "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live";
const GRAPHQL_URL: &str = "https://launcher.store.epicgames.com/graphql";
const FREE_GAMES_URL: &str =
    "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
const PRODUCT_CDN: &str = "https://store-content-ipv4.ak.epicgames.com/api";
const EGDATA_URL: &str = "https://api.egdata.app";
const CACHE_TTL: Duration = Duration::from_secs(300);

const SEARCH_QUERY: &str = r#"
query searchStoreQuery(
  $keywords: String,
  $category: String,
  $count: Int,
  $country: String!,
  $locale: String,
  $sortBy: String,
  $sortDir: String,
  $start: Int,
  $tag: String,
  $withPrice: Boolean = true,
  $withPromotions: Boolean = false
) {
  Catalog {
    searchStore(
      keywords: $keywords,
      category: $category,
      count: $count,
      country: $country,
      locale: $locale,
      sortBy: $sortBy,
      sortDir: $sortDir,
      start: $start,
      tag: $tag
    ) {
      elements {
        id
        namespace
        title
        description
        productSlug
        urlSlug
        effectiveDate
        seller { id name }
        keyImages { type url }
        categories { path }
        customAttributes { key value }
        price(country: $country) @include(if: $withPrice) {
          totalPrice {
            discountPrice
            originalPrice
            discount
            currencyCode
            fmtPrice(locale: $locale) {
              originalPrice
              discountPrice
              intermediatePrice
            }
          }
        }
        promotions(category: "games") @include(if: $withPromotions) {
          promotionalOffers {
            promotionalOffers {
              startDate
              endDate
              discountSetting { discountType discountPercentage }
            }
          }
          upcomingPromotionalOffers {
            promotionalOffers {
              startDate
              endDate
              discountSetting { discountType discountPercentage }
            }
          }
        }
      }
      paging { count total }
    }
  }
}
"#;

const WISHLIST_QUERY: &str = r#"
query getWishlistQuery($country: String!, $locale: String, $start: Int, $count: Int) {
  Wishlist {
    wishlistItems(start: $start, count: $count) {
      elements {
        id
        offerId
        namespace
        created
        updated
        offer(locale: $locale) {
          id
          namespace
          title
          description
          productSlug
          urlSlug
          effectiveDate
          seller { id name }
          keyImages { type url }
          price(country: $country) {
            totalPrice {
              discountPrice
              originalPrice
              discount
              currencyCode
              fmtPrice(locale: $locale) {
                originalPrice
                discountPrice
                intermediatePrice
              }
            }
          }
        }
      }
      paging { count total }
    }
  }
}
"#;

const ADD_WISHLIST_MUTATION: &str = r#"
mutation addToWishlist($namespace: String!, $offerId: String!) {
  Wishlist {
    addToWishlist(namespace: $namespace, offerId: $offerId) {
      success
    }
  }
}
"#;

const REMOVE_WISHLIST_MUTATION: &str = r#"
mutation removeFromWishlist($namespace: String!, $offerId: String!, $operation: String) {
  Wishlist {
    removeFromWishlist(namespace: $namespace, offerId: $offerId, operation: $operation) {
      success
    }
  }
}
"#;

// ─── Serde Yapıları ─────────────────────────────────────────────────

// -- GraphQL yanıt sarmalayıcıları --

#[derive(Deserialize)]
struct GqlResp<T> {
    data: Option<T>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Deserialize)]
struct CatalogWrap {
    #[serde(rename = "Catalog")]
    catalog: CatalogInner,
}

#[derive(Deserialize)]
struct CatalogInner {
    #[serde(rename = "searchStore")]
    search_store: SearchStoreRaw,
}

#[derive(Deserialize)]
struct SearchStoreRaw {
    elements: Vec<StoreElement>,
    paging: Paging,
}

// -- İstek listesi sarmalayıcılar --

#[derive(Deserialize)]
struct WishlistWrap {
    #[serde(rename = "Wishlist")]
    wishlist: WishlistInner,
}

#[derive(Deserialize)]
struct WishlistInner {
    #[serde(rename = "wishlistItems")]
    wishlist_items: WishlistItemsRaw,
}

#[derive(Deserialize)]
struct WishlistItemsRaw {
    elements: Vec<WishlistItemRaw>,
    paging: Paging,
}

#[derive(Deserialize)]
struct WishlistItemRaw {
    id: String,
    #[serde(rename = "offerId")]
    offer_id: String,
    namespace: String,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    updated: Option<String>,
    offer: Option<StoreElement>,
}

#[derive(Deserialize)]
struct MutationWrap {
    #[serde(rename = "Wishlist")]
    _wishlist: Option<serde_json::Value>,
}

// -- Mağaza öğesi (ana veri yapısı) --

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreElement {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "productSlug")]
    pub product_slug: Option<String>,
    #[serde(default, rename = "urlSlug")]
    pub url_slug: Option<String>,
    #[serde(default, rename = "effectiveDate")]
    pub effective_date: Option<String>,
    #[serde(default)]
    pub seller: Option<Seller>,
    #[serde(default, rename = "keyImages")]
    pub key_images: Vec<KeyImage>,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default, rename = "customAttributes")]
    pub custom_attributes: Vec<CustomAttr>,
    #[serde(default)]
    pub price: Option<PriceInfo>,
    #[serde(default)]
    pub promotions: Option<Promotions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyImage {
    #[serde(rename = "type", default)]
    pub image_type: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Seller {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAttr {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceInfo {
    pub total_price: TotalPrice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalPrice {
    #[serde(default)]
    pub discount_price: i64,
    #[serde(default)]
    pub original_price: i64,
    #[serde(default)]
    pub discount: i64,
    #[serde(default)]
    pub currency_code: String,
    #[serde(default)]
    pub fmt_price: Option<FmtPrice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FmtPrice {
    #[serde(default)]
    pub original_price: String,
    #[serde(default)]
    pub discount_price: String,
    #[serde(default)]
    pub intermediate_price: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Promotions {
    #[serde(default)]
    pub promotional_offers: Vec<PromotionGroup>,
    #[serde(default)]
    pub upcoming_promotional_offers: Vec<PromotionGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionGroup {
    #[serde(default)]
    pub promotional_offers: Vec<PromotionOffer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionOffer {
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub discount_setting: Option<DiscountSetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountSetting {
    #[serde(default)]
    pub discount_type: String,
    #[serde(default)]
    pub discount_percentage: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Paging {
    #[serde(default)]
    pub count: i32,
    #[serde(default)]
    pub total: i32,
}

// -- Frontend'e dönen birleşik yapılar --

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreHome {
    pub featured: Vec<StoreElement>,
    pub free_current: Vec<StoreElement>,
    pub free_upcoming: Vec<StoreElement>,
    pub top_sellers: Vec<StoreElement>,
    pub new_releases: Vec<StoreElement>,
    pub on_sale: Vec<StoreElement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub elements: Vec<StoreElement>,
    pub paging: Paging,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistEntry {
    pub id: String,
    pub offer_id: String,
    pub namespace: String,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub offer: Option<StoreElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductDetail {
    pub about: String,
    pub gallery: Vec<MediaItem>,
    pub short_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    #[serde(rename = "type", default)]
    pub media_type: String,
    #[serde(default)]
    pub url: String,
}

// ─── Önbellek ───────────────────────────────────────────────────────

static HOME_CACHE: Mutex<Option<(Instant, StoreHome)>> = Mutex::new(None);

// ─── HTTP İstemci ───────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(EPIC_LAUNCHER_UA)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP istemci oluşturulamadı: {e}"))
}

async fn graphql_post<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    query: &str,
    variables: serde_json::Value,
) -> Result<T, String> {
    let body = serde_json::json!({
        "query": query,
        "variables": variables,
    });
    let resp = client
        .post(GRAPHQL_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GraphQL isteği başarısız: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("GraphQL HTTP {status}: {}", &txt[..txt.len().min(300)]));
    }

    let gql: GqlResp<T> = resp
        .json()
        .await
        .map_err(|e| format!("GraphQL yanıtı ayrıştırılamadı: {e}"))?;

    if let Some(errors) = gql.errors {
        if !errors.is_empty() {
            let msgs: Vec<_> = errors.iter().map(|e| e.message.as_str()).collect();
            return Err(format!("GraphQL hatası: {}", msgs.join("; ")));
        }
    }

    gql.data.ok_or_else(|| "GraphQL: veri boş".into())
}

async fn graphql_post_auth<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<T, String> {
    let body = serde_json::json!({
        "query": query,
        "variables": variables,
    });
    // Auth istekleri ana graphql endpoint'ine gider
    let resp = client
        .post("https://graphql.epicgames.com/graphql")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GraphQL auth isteği başarısız: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("GraphQL HTTP {status}: {}", &txt[..txt.len().min(300)]));
    }

    let gql: GqlResp<T> = resp
        .json()
        .await
        .map_err(|e| format!("GraphQL auth yanıtı ayrıştırılamadı: {e}"))?;

    if let Some(errors) = gql.errors {
        if !errors.is_empty() {
            let msgs: Vec<_> = errors.iter().map(|e| e.message.as_str()).collect();
            return Err(format!("GraphQL hatası: {}", msgs.join("; ")));
        }
    }

    gql.data.ok_or_else(|| "GraphQL: veri boş".into())
}

// ─── Veri Çekme Fonksiyonları ───────────────────────────────────────

/// Akamai CDN'den ücretsiz oyunları çeker (aktif + gelecek).
async fn fetch_free_games(
    client: &reqwest::Client,
) -> Result<(Vec<StoreElement>, Vec<StoreElement>), String> {
    let url = format!(
        "{FREE_GAMES_URL}?locale=tr-TR&country=TR&allowCountries=TR"
    );
    let resp: GqlResp<CatalogWrap> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ücretsiz oyunlar çekilemedi: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Ücretsiz oyunlar ayrıştırılamadı: {e}"))?;

    let elements = resp
        .data
        .map(|d| d.catalog.search_store.elements)
        .unwrap_or_default();

    let now = chrono_now_iso();
    let mut current = Vec::new();
    let mut upcoming = Vec::new();

    for el in elements {
        if let Some(ref promos) = el.promotions {
            // Şu an ücretsiz olanlar
            let is_free_now = promos.promotional_offers.iter().any(|g| {
                g.promotional_offers.iter().any(|p| {
                    p.discount_setting
                        .as_ref()
                        .is_some_and(|d| d.discount_percentage == 0)
                        && p.start_date <= now
                        && p.end_date > now
                })
            });
            if is_free_now {
                current.push(el.clone());
            }
            // Gelecek ücretsizler
            let is_upcoming = promos.upcoming_promotional_offers.iter().any(|g| {
                g.promotional_offers.iter().any(|p| {
                    p.discount_setting
                        .as_ref()
                        .is_some_and(|d| d.discount_percentage == 0)
                })
            });
            if is_upcoming && !is_free_now {
                upcoming.push(el);
            }
        }
    }

    Ok((current, upcoming))
}

/// Anlık ISO 8601 zaman damgası (basit — chrono bağımlılığı eklemeden).
fn chrono_now_iso() -> String {
    // Basit bir yaklaşım: SystemTime → secs → elle format
    // legendary zaten epoch tabanlı tarih karşılaştırması yapıyor ama
    // burada string karşılaştırması yeterli (ISO 8601 sıralanabilir).
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Basit UTC hesabı (yıl/ay/gün/saat/dk/sn)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Gün → tarih dönüşümü (basitleştirilmiş)
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.000Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Algoritma: https://howardhinnant.github.io/date_algorithms.html
    days += 719468;
    let era = days / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if mo <= 2 { y + 1 } else { y };
    (yr, mo, d)
}

/// GraphQL ile katalog araması yapar.
async fn search_catalog(
    client: &reqwest::Client,
    keywords: Option<&str>,
    category: Option<&str>,
    sort_by: &str,
    sort_dir: &str,
    start: i32,
    count: i32,
    with_promotions: bool,
) -> Result<(Vec<StoreElement>, Paging), String> {
    let mut vars = serde_json::json!({
        "country": "TR",
        "locale": "tr-TR",
        "sortBy": sort_by,
        "sortDir": sort_dir,
        "start": start,
        "count": count,
        "withPrice": true,
        "withPromotions": with_promotions,
    });
    if let Some(kw) = keywords {
        vars["keywords"] = serde_json::Value::String(kw.to_string());
    }
    if let Some(cat) = category {
        vars["category"] = serde_json::Value::String(cat.to_string());
    }

    let wrap: CatalogWrap = graphql_post(client, SEARCH_QUERY, vars).await?;
    Ok((wrap.catalog.search_store.elements, wrap.catalog.search_store.paging))
}

/// Akamai CDN'den ürün detay sayfası bilgilerini çeker.
async fn fetch_product_cdn(
    client: &reqwest::Client,
    slug: &str,
) -> Result<Option<ProductDetail>, String> {
    let url = format!("{PRODUCT_CDN}/tr-TR/content/products/{slug}");
    let resp = client.get(&url).send().await;
    let resp = match resp {
        Ok(r) => r,
        Err(_) => {
            // Türkçe yoksa İngilizce dene
            let url_en = format!("{PRODUCT_CDN}/en-US/content/products/{slug}");
            client.get(&url_en).send().await.map_err(|e| format!("CDN isteği başarısız: {e}"))?
        }
    };

    if resp.status() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Ok(None);
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("CDN yanıtı ayrıştırılamadı: {e}"))?;

    // pages[].data içinden about ve gallery çıkar
    let mut about = String::new();
    let mut gallery = Vec::new();
    let mut short_desc = None;

    if let Some(pages) = json.get("pages").and_then(|p| p.as_array()) {
        for page in pages {
            if let Some(data) = page.get("data") {
                // about alanı (zengin metin açıklama)
                if about.is_empty() {
                    if let Some(ab) = data.get("about") {
                        if let Some(desc) = ab.get("description").and_then(|d| d.as_str()) {
                            about = desc.to_string();
                        }
                        if let Some(sd) = ab.get("shortDescription").and_then(|d| d.as_str()) {
                            short_desc = Some(sd.to_string());
                        }
                    }
                }
                // gallery alanı (ekran görüntüleri)
                if let Some(gal) = data.get("gallery") {
                    if let Some(items) = gal.get("galleryImages").and_then(|g| g.as_array()) {
                        for item in items {
                            if let Some(src) = item.get("src").and_then(|s| s.as_str()) {
                                gallery.push(MediaItem {
                                    media_type: "image".to_string(),
                                    url: src.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    if about.is_empty() && gallery.is_empty() {
        return Ok(None);
    }

    Ok(Some(ProductDetail {
        about,
        gallery,
        short_description: short_desc,
    }))
}

/// user.json'dan access_token okur.
fn read_access_token() -> Result<String, String> {
    let config = super::skip::default_config_dir();
    let user_file = config.join("user.json");
    let text = std::fs::read_to_string(&user_file)
        .map_err(|_| "Epic hesabına giriş yapılmamış".to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("user.json geçersiz: {e}"))?;
    json.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "access_token bulunamadı".into())
}

/// EGData.app fallback araması.
async fn egdata_search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<StoreElement>, String> {
    let url = format!("{EGDATA_URL}/v1/search?q={}", urlencoding(query));

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("EGData arama başarısız: {e}"))?;

    if !resp.status().is_success() {
        return Ok(Vec::new());
    }

    // EGData yanıtını StoreElement'e dönüştür (basitleştirilmiş)
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("EGData yanıtı ayrıştırılamadı: {e}"))?;

    let mut out = Vec::new();
    if let Some(hits) = json.get("hits").and_then(|h| h.as_array())
        .or_else(|| json.get("elements").and_then(|e| e.as_array()))
        .or_else(|| json.as_array())
    {
        for hit in hits.iter().take(20) {
            let el = StoreElement {
                id: hit.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                namespace: hit.get("namespace").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                title: hit.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                description: hit.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                product_slug: hit.get("productSlug").and_then(|v| v.as_str()).map(String::from),
                url_slug: hit.get("urlSlug").and_then(|v| v.as_str()).map(String::from),
                effective_date: hit.get("effectiveDate").and_then(|v| v.as_str()).map(String::from),
                seller: None,
                key_images: Vec::new(),
                categories: Vec::new(),
                custom_attributes: Vec::new(),
                price: None,
                promotions: None,
            };
            if !el.title.is_empty() {
                out.push(el);
            }
        }
    }

    Ok(out)
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// ─── Tauri Komutları ────────────────────────────────────────────────

/// Ana sayfa verisini çeker (5 dk önbellek).
#[tauri::command]
pub async fn epic_store_home() -> Result<StoreHome, String> {
    // Önbellek kontrolü
    if let Ok(guard) = HOME_CACHE.lock() {
        if let Some((ts, ref cached)) = *guard {
            if ts.elapsed() < CACHE_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let client = build_client()?;

    // Paralel istekler
    let (free_result, new_result, sale_result, top_result) = tokio::join!(
        fetch_free_games(&client),
        search_catalog(&client, None, Some("games/edition/base"), "releaseDate", "DESC", 0, 20, false),
        search_catalog(&client, None, Some("games/edition/base"), "currentPrice", "ASC", 0, 40, false),
        search_catalog(&client, None, Some("games/edition/base"), "relevancy", "DESC", 0, 20, false),
    );

    let (free_current, free_upcoming) = free_result.unwrap_or_default();
    let (new_releases, _) = new_result.unwrap_or_default();

    // İndirimli olanları filtrele
    let (sale_raw, _) = sale_result.unwrap_or_default();
    let on_sale: Vec<StoreElement> = sale_raw
        .into_iter()
        .filter(|el| {
            el.price.as_ref().is_some_and(|p| {
                p.total_price.original_price > 0
                    && p.total_price.discount_price < p.total_price.original_price
                    && p.total_price.discount_price > 0
            })
        })
        .take(20)
        .collect();

    let (top_sellers, _) = top_result.unwrap_or_default();

    // Featured = ücretsiz oyunlar + top seller'lardan ilk birkaçı
    let mut featured = Vec::new();
    for el in free_current.iter().take(2) {
        featured.push(el.clone());
    }
    for el in top_sellers.iter().take(4) {
        if !featured.iter().any(|f| f.id == el.id) {
            featured.push(el.clone());
        }
    }

    let home = StoreHome {
        featured,
        free_current,
        free_upcoming,
        top_sellers,
        new_releases,
        on_sale,
    };

    // Önbelleğe yaz
    if let Ok(mut guard) = HOME_CACHE.lock() {
        *guard = Some((Instant::now(), home.clone()));
    }

    Ok(home)
}

/// Katalog araması.
#[tauri::command]
pub async fn epic_store_search(
    keywords: Option<String>,
    category: Option<String>,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    page: Option<i32>,
    count: Option<i32>,
) -> Result<SearchResult, String> {
    let client = build_client()?;
    let cnt = count.unwrap_or(20);
    let start = page.unwrap_or(0) * cnt;
    let sb = sort_by.as_deref().unwrap_or("relevancy");
    let sd = sort_dir.as_deref().unwrap_or("DESC");

    let result = search_catalog(
        &client,
        keywords.as_deref(),
        category.as_deref(),
        sb,
        sd,
        start,
        cnt,
        false,
    )
    .await;

    match result {
        Ok((elements, paging)) => Ok(SearchResult { elements, paging }),
        Err(e) => {
            // Epic başarısızsa EGData fallback (sadece arama)
            if let Some(kw) = &keywords {
                if let Ok(elements) = egdata_search(&client, kw).await {
                    if !elements.is_empty() {
                        let total = elements.len() as i32;
                        return Ok(SearchResult {
                            elements,
                            paging: Paging { count: total, total },
                        });
                    }
                }
            }
            Err(e)
        }
    }
}

/// Ürün detay sayfası (CDN'den).
#[tauri::command]
pub async fn epic_store_product_detail(slug: String) -> Result<Option<ProductDetail>, String> {
    let client = build_client()?;
    fetch_product_cdn(&client, &slug).await
}

/// İstek listesini çeker (oturum gerektirir).
#[tauri::command]
pub async fn epic_store_wishlist() -> Result<Vec<WishlistEntry>, String> {
    let token = read_access_token()?;
    let client = build_client()?;

    let vars = serde_json::json!({
        "country": "TR",
        "locale": "tr-TR",
        "start": 0,
        "count": 100,
    });

    let wrap: WishlistWrap = graphql_post_auth(&client, &token, WISHLIST_QUERY, vars).await?;

    let entries: Vec<WishlistEntry> = wrap
        .wishlist
        .wishlist_items
        .elements
        .into_iter()
        .map(|w| WishlistEntry {
            id: w.id,
            offer_id: w.offer_id,
            namespace: w.namespace,
            created: w.created,
            updated: w.updated,
            offer: w.offer,
        })
        .collect();

    Ok(entries)
}

/// İstek listesine ekler.
#[tauri::command]
pub async fn epic_store_add_wishlist(
    namespace: String,
    offer_id: String,
) -> Result<(), String> {
    let token = read_access_token()?;
    let client = build_client()?;

    let vars = serde_json::json!({
        "namespace": namespace,
        "offerId": offer_id,
    });

    let _: MutationWrap =
        graphql_post_auth(&client, &token, ADD_WISHLIST_MUTATION, vars).await?;
    Ok(())
}

/// İstek listesinden çıkarır.
#[tauri::command]
pub async fn epic_store_remove_wishlist(
    namespace: String,
    offer_id: String,
) -> Result<(), String> {
    let token = read_access_token()?;
    let client = build_client()?;

    let vars = serde_json::json!({
        "namespace": namespace,
        "offerId": offer_id,
        "operation": "REMOVE",
    });

    let _: MutationWrap =
        graphql_post_auth(&client, &token, REMOVE_WISHLIST_MUTATION, vars).await?;
    Ok(())
}

// ─── Yardımcı: StoreElement üzerinden görsel seçimi ─────────────────

impl StoreElement {
    /// Geniş yatay afiş (16:9).
    pub fn wide_image(&self) -> Option<&str> {
        self.key_images
            .iter()
            .find(|k| {
                k.image_type == "OfferImageWide"
                    || k.image_type == "DieselStoreFrontWide"
                    || k.image_type == "featuredMedia"
            })
            .or_else(|| self.key_images.first())
            .map(|k| k.url.as_str())
    }

    /// Dikey poster (2:3).
    pub fn tall_image(&self) -> Option<&str> {
        self.key_images
            .iter()
            .find(|k| {
                k.image_type == "OfferImageTall"
                    || k.image_type == "DieselGameBoxTall"
                    || k.image_type == "DieselGameBox"
            })
            .or_else(|| self.key_images.first())
            .map(|k| k.url.as_str())
    }

    /// Küçük resim.
    pub fn thumbnail(&self) -> Option<&str> {
        self.key_images
            .iter()
            .find(|k| k.image_type == "Thumbnail")
            .or_else(|| self.key_images.first())
            .map(|k| k.url.as_str())
    }

    /// İndirim yüzdesi (0 = indirim yok).
    pub fn discount_percent(&self) -> i32 {
        self.price.as_ref().map_or(0, |p| {
            let orig = p.total_price.original_price;
            let disc = p.total_price.discount_price;
            if orig > 0 && disc < orig {
                (((orig - disc) as f64 / orig as f64) * 100.0).round() as i32
            } else {
                0
            }
        })
    }

    /// Ücretsiz mi? (fiyat 0 veya promosyon aktif).
    pub fn is_free(&self) -> bool {
        self.price
            .as_ref()
            .is_some_and(|p| p.total_price.discount_price == 0 && p.total_price.original_price > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chrono_now_iso() {
        let ts = chrono_now_iso();
        assert!(ts.starts_with("20"));
        assert!(ts.ends_with("Z"));
        assert!(ts.contains("T"));
    }

    #[test]
    fn test_days_to_ymd() {
        // 2024-01-01 = epoch day 19723
        let (y, m, d) = days_to_ymd(19723);
        assert_eq!((y, m, d), (2024, 1, 1));
    }

    #[test]
    fn test_discount_percent() {
        let el = StoreElement {
            id: "test".into(),
            namespace: "".into(),
            title: "Test".into(),
            description: "".into(),
            product_slug: None,
            url_slug: None,
            effective_date: None,
            seller: None,
            key_images: vec![],
            categories: vec![],
            custom_attributes: vec![],
            price: Some(PriceInfo {
                total_price: TotalPrice {
                    discount_price: 750,
                    original_price: 1000,
                    discount: 250,
                    currency_code: "TRY".into(),
                    fmt_price: None,
                },
            }),
            promotions: None,
        };
        assert_eq!(el.discount_percent(), 25);
    }

    #[test]
    fn test_wide_image_selection() {
        let el = StoreElement {
            id: "test".into(),
            namespace: "".into(),
            title: "Test".into(),
            description: "".into(),
            product_slug: None,
            url_slug: None,
            effective_date: None,
            seller: None,
            key_images: vec![
                KeyImage {
                    image_type: "Thumbnail".into(),
                    url: "https://thumb.jpg".into(),
                },
                KeyImage {
                    image_type: "OfferImageWide".into(),
                    url: "https://wide.jpg".into(),
                },
            ],
            categories: vec![],
            custom_attributes: vec![],
            price: None,
            promotions: None,
        };
        assert_eq!(el.wide_image(), Some("https://wide.jpg"));
        assert_eq!(el.thumbnail(), Some("https://thumb.jpg"));
    }

    #[test]
    fn test_urlencoding() {
        assert_eq!(urlencoding("hello world"), "hello+world");
        assert_eq!(urlencoding("test&foo=bar"), "test%26foo%3Dbar");
    }
}
