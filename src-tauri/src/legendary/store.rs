//! Epic Games Store yerleşik (native) mağaza entegrasyonu.
//!
//! Epic Games resmi CDN'i (`store-site-backend-static`), `egdata.app` REST API'si
//! ve Epic Games Launcher GraphQL uç noktası (`launcher.store.epicgames.com/graphql`)
//! üzerinden ücretsiz promosyonları, çok satanları, indirimleri, istek listesini ve sepeti yönetir.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::models::SystemRequirement;
use super::skip::default_config_dir;

/// Haftalık veya günlük ücretsiz oyun öğesi
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreFreeGameItem {
    pub id: String,
    pub namespace: String,
    pub title: String,
    pub description: String,
    pub cover: String,
    pub wide_art: String,
    pub original_price: Option<String>,
    pub discount_price: Option<String>,
    pub is_free_now: bool,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub product_slug: Option<String>,
    pub url_slug: Option<String>,
    pub page_slug: Option<String>,
}

/// Mağaza oyun / teklif öğesi
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreOfferItem {
    pub id: String,
    pub namespace: String,
    pub title: String,
    pub description: Option<String>,
    pub cover: String,
    pub wide_art: String,
    pub seller: Option<String>,
    pub original_price: Option<String>,
    pub discount_price: Option<String>,
    pub discount_percentage: Option<i64>,
    pub currency: Option<String>,
    pub product_slug: Option<String>,
    pub url_slug: Option<String>,
    pub page_slug: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Ürün sayfası medya öğesi (ekran görüntüsü veya fragman)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoreMediaItem {
    /// "image" | "trailer"
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub thumb: String,
    #[serde(default)]
    pub full: String,
    #[serde(default)]
    pub caption: Option<String>,
}

/// Ürün sayfası harici bağlantısı (sosyal medya, resmi site)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoreLink {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
}

/// Epic mağaza ürün sayfası içeriği (Akamai CDN `content/products/<slug>`).
/// Yalnızca katalogda kayıtlı eski/yerleşik ürünlerde bulunur; bulunamazsa
/// egdata verisiyle yetinilir (bkz. `fetch_store_offer_detail`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StorePageContent {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub about_title: Option<String>,
    #[serde(default)]
    pub about_short: Option<String>,
    #[serde(default)]
    pub about_long: Option<String>,
    #[serde(default)]
    pub about_image: Option<String>,
    #[serde(default)]
    pub hero_logo: Option<String>,
    #[serde(default)]
    pub hero_wide: Option<String>,
    #[serde(default)]
    pub hero_portrait: Option<String>,
    #[serde(default)]
    pub media: Vec<StoreMediaItem>,
    #[serde(default)]
    pub requirements: Vec<SystemRequirement>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub age_rating: Option<String>,
    #[serde(default)]
    pub links: Vec<StoreLink>,
}

/// Detaylı mağaza oyun sayfası bilgisi
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreOfferDetail {
    pub id: String,
    pub namespace: String,
    pub title: String,
    pub description: Option<String>,
    pub long_description: Option<String>,
    pub cover: String,
    pub wide_art: String,
    #[serde(default)]
    pub screenshots: Vec<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub release_date: Option<String>,
    pub original_price: Option<String>,
    pub discount_price: Option<String>,
    pub discount_percentage: Option<i64>,
    pub currency: Option<String>,
    pub product_slug: Option<String>,
    pub url_slug: Option<String>,
    pub page_slug: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub is_in_wishlist: bool,
    pub is_in_cart: bool,
    // --- Zengin ürün sayfası alanları (v2) ---
    /// Tür etiketleri (RPG, Action, Simulation…)
    #[serde(default)]
    pub genres: Vec<String>,
    /// Oynanış özellikleri (Tek Oyunculu, Co-op, Başarımlar, Bulut Kayıt…)
    #[serde(default)]
    pub features: Vec<String>,
    /// Desteklenen platformlar (Windows, Mac)
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Yaş sınıflandırması (PEGI 18 vb.)
    #[serde(default)]
    pub age_rating: Option<String>,
    /// Dikey kapağın yanında kullanılan geniş "about" görseli
    #[serde(default)]
    pub about_image: Option<String>,
    /// Hero üzerine bindirilen oyun logosu (şeffaf PNG)
    #[serde(default)]
    pub hero_logo: Option<String>,
    /// Birleşik medya galerisi (ekran görüntüleri + fragman kapakları)
    #[serde(default)]
    pub media: Vec<StoreMediaItem>,
    /// Sistem gereksinimleri (Minimum / Önerilen)
    #[serde(default)]
    pub requirements: Vec<SystemRequirement>,
    /// Seslendirme/altyazı dil bilgisi satırları
    #[serde(default)]
    pub languages: Vec<String>,
    /// Resmi site / sosyal medya bağlantıları
    #[serde(default)]
    pub links: Vec<StoreLink>,
    /// CDN ürün sayfası içeriği bulunabildi mi? (false ise UI "sınırlı bilgi" notu gösterir)
    #[serde(default)]
    pub has_page_content: bool,
    /// Eşleşen mağaza slug'ı (yerleşik webview linkleri için)
    #[serde(default)]
    pub resolved_slug: Option<String>,
}

/// Mağaza ana hub yanıtı
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreHubResponse {
    #[serde(default = "default_country_tr")]
    pub country: String,
    pub free_games_active: Vec<StoreFreeGameItem>,
    pub free_games_upcoming: Vec<StoreFreeGameItem>,
    pub top_sellers: Vec<StoreOfferItem>,
    pub featured_discounts: Vec<StoreOfferItem>,
    pub upcoming_offers: Vec<StoreOfferItem>,
    pub wishlist_offer_ids: Vec<String>,
    pub cart_offer_ids: Vec<String>,
    pub updated_at: u64,
}

fn default_country_tr() -> String {
    "TR".to_string()
}

fn cache_file_path() -> PathBuf {
    default_config_dir().join("store_hub_cache.json")
}

fn local_wishlist_path() -> PathBuf {
    default_config_dir().join("store_local_wishlist.json")
}

fn local_cart_path() -> PathBuf {
    default_config_dir().join("store_local_cart.json")
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Kullanıcının yapılandırmasından (`user.json`) ülke kodunu oku (varsayılan "TR")
pub fn get_user_country(config_dir: &Path) -> String {
    let user_file = config_dir.join("user.json");
    if let Ok(content) = fs::read_to_string(&user_file) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(c) = val.get("country").and_then(|v| v.as_str()) {
                let trimmed = c.trim().to_uppercase();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
        }
    }
    "TR".to_string()
}

/// Ülkeye göre yerel dil kodu döndürür
pub fn get_locale_for_country(country: &str) -> &'static str {
    match country.to_uppercase().as_str() {
        "TR" => "tr-TR",
        "PT" | "BR" => "pt-BR",
        "DE" => "de-DE",
        "FR" => "fr-FR",
        "ES" => "es-ES",
        "IT" => "it-IT",
        "RU" => "ru-RU",
        "PL" => "pl-PL",
        "JA" | "JP" => "ja-JP",
        "KO" | "KR" => "ko-KR",
        _ => "en-US",
    }
}

/// İndirim yüzdesini FİYATLARDAN hesaplar.
///
/// NEDEN `appliedRules` KULLANILMIYOR: egdata süresi geçmiş bir kampanya kuralını
/// döndürebiliyor ve oradaki `discountPercentage` gerçek fiyat farkıyla uyuşmuyor.
/// Ölçülen örnekler (2026-09-18): Satisfactory fiyat %30 düşerken kural %70,
/// Subnautica %75 düşerken kural %25, Hogwarts Legacy %90 düşerken kural %10 diyordu.
/// Yanlış yüzde kullanıcıya yanlış indirim vaat eder; fiyat farkı ise her zaman
/// gösterilen fiyatlarla tutarlıdır.
fn discount_pct_from_prices(original: f64, discounted: f64) -> Option<i64> {
    if original > 0.0 && discounted < original {
        Some((((original - discounted) / original) * 100.0).round() as i64)
    } else {
        None
    }
}

/// Sayı basamaklarını binlik ayraçla biçimlendirir
fn format_thousands(n: i64, sep: char) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    for (i, &ch) in chars.iter().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(sep);
        }
        out.push(ch);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

/// Para birimini ve tutarı bölgesel standartta biçimlendirir
pub fn format_currency(cents: f64, currency: &str) -> String {
    let curr = currency.trim().to_uppercase();
    let whole = cents.trunc() as i64;
    let frac = (cents.fract().abs() * 100.0).round() as i64;

    match curr.as_str() {
        "TRY" | "TL" => {
            let whole_str = format_thousands(whole, '.');
            format!("₺{whole_str},{frac:02}")
        }
        "EUR" => {
            let whole_str = format_thousands(whole, '.');
            format!("{whole_str},{frac:02} €")
        }
        "USD" => {
            let whole_str = format_thousands(whole, ',');
            format!("${whole_str}.{frac:02}")
        }
        "GBP" => {
            let whole_str = format_thousands(whole, ',');
            format!("£{whole_str}.{frac:02}")
        }
        _ => {
            let whole_str = format_thousands(whole, '.');
            format!("{whole_str},{frac:02} {curr}")
        }
    }
}

/// Diskten önbelleklenmiş yerel istek listesini oku
pub fn read_local_wishlist() -> HashSet<String> {
    let path = local_wishlist_path();
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(set) = serde_json::from_str::<HashSet<String>>(&content) {
            return set;
        }
    }
    HashSet::new()
}

/// Diskten önbelleklenmiş yerel sepeti oku
pub fn read_local_cart() -> HashSet<String> {
    let path = local_cart_path();
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(set) = serde_json::from_str::<HashSet<String>>(&content) {
            return set;
        }
    }
    HashSet::new()
}

/// İstek listesini yerel diske kaydet
pub fn save_local_wishlist(set: &HashSet<String>) -> Result<(), String> {
    let path = local_wishlist_path();
    let content = serde_json::to_string_pretty(set)
        .map_err(|e| format!("İstek listesi serileştirilemedi: {e}"))?;
    fs::write(path, content).map_err(|e| format!("İstek listesi kaydedilemedi: {e}"))?;
    Ok(())
}

/// Sepeti yerel diske kaydet
pub fn save_local_cart(set: &HashSet<String>) -> Result<(), String> {
    let path = local_cart_path();
    let content = serde_json::to_string_pretty(set)
        .map_err(|e| format!("Sepet serileştirilemedi: {e}"))?;
    fs::write(path, content).map_err(|e| format!("Sepet kaydedilemedi: {e}"))?;
    Ok(())
}

/// İstek listesine ekle/çıkar (toggle)
pub fn toggle_wishlist_item(offer_id: &str) -> Result<bool, String> {
    let mut list = read_local_wishlist();
    let id_str = offer_id.trim().to_string();
    if id_str.is_empty() {
        return Err("Geçersiz offer_id".into());
    }
    let is_in = if list.contains(&id_str) {
        list.remove(&id_str);
        false
    } else {
        list.insert(id_str);
        true
    };
    save_local_wishlist(&list)?;
    Ok(is_in)
}

/// Sepete ekle/çıkar (toggle)
pub fn toggle_cart_item(offer_id: &str) -> Result<bool, String> {
    let mut cart = read_local_cart();
    let id_str = offer_id.trim().to_string();
    if id_str.is_empty() {
        return Err("Geçersiz offer_id".into());
    }
    let is_in = if cart.contains(&id_str) {
        cart.remove(&id_str);
        false
    } else {
        cart.insert(id_str);
        true
    };
    save_local_cart(&cart)?;
    Ok(is_in)
}

/// Epic Games Launcher GraphQL üzerinden kullanıcının canlı istek listesini çek
pub async fn fetch_epic_user_wishlist(config_dir: &Path) -> Result<Vec<StoreOfferItem>, String> {
    let user_file = config_dir.join("user.json");
    if !user_file.is_file() {
        return Err("user.json bulunamadı".into());
    }

    let country = get_user_country(config_dir);
    let locale = get_locale_for_country(&country);

    let user_content = fs::read_to_string(&user_file).map_err(|e| e.to_string())?;
    let user_val: serde_json::Value = serde_json::from_str(&user_content).map_err(|e| e.to_string())?;
    let access_token = match user_val.get("access_token").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return Err("access_token bulunamadı".into()),
    };

    let query = format!(
        r#"
        query WishlistQuery {{
          Wishlist {{
            wishlistItems {{
              elements {{
                id
                offerId
                namespace
                created
                updated
                offer {{
                  title
                  id
                  namespace
                  productSlug
                  urlSlug
                  keyImages {{
                    type
                    url
                  }}
                  seller {{
                    name
                  }}
                  price(country: "{country}") {{
                    totalPrice {{
                      discountPrice
                      originalPrice
                      discount
                      currencyCode
                      fmtPrice(locale: "{locale}") {{
                        originalPrice
                        discountPrice
                      }}
                    }}
                  }}
                }}
              }}
            }}
          }}
        }}
        "#
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post("https://launcher.store.epicgames.com/graphql")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header(
            "User-Agent",
            "EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live",
        )
        .body(serde_json::json!({ "query": query }).to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GraphQL HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut items = Vec::new();

    if let Some(elements) = json
        .pointer("/data/Wishlist/wishlistItems/elements")
        .and_then(|v| v.as_array())
    {
        for el in elements {
            let offer_id = el.get("offerId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let ns = el.get("namespace").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let offer = match el.get("offer") {
                Some(o) if !o.is_null() => o,
                _ => continue,
            };

            let title = offer.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if title.is_empty() {
                continue;
            }

            let mut cover = String::new();
            let mut wide_art = String::new();
            if let Some(images) = offer.get("keyImages").and_then(|v| v.as_array()) {
                for img in images {
                    let itype = img.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                    let url = img.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    if itype.eq_ignore_ascii_case("OfferImageTall") || itype.eq_ignore_ascii_case("DieselStoreFrontTall") {
                        if cover.is_empty() { cover = url.clone(); }
                    } else if itype.eq_ignore_ascii_case("OfferImageWide") || itype.eq_ignore_ascii_case("DieselStoreFrontWide") {
                        if wide_art.is_empty() { wide_art = url.clone(); }
                    } else if cover.is_empty() && (itype.eq_ignore_ascii_case("Thumbnail") || itype.eq_ignore_ascii_case("ProductLogo")) {
                        cover = url.clone();
                    }
                }
            }

            let seller = offer.pointer("/seller/name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let fmt_orig = offer.pointer("/price/totalPrice/fmtPrice/originalPrice").and_then(|v| v.as_str()).map(|s| s.to_string());
            let fmt_disc = offer.pointer("/price/totalPrice/fmtPrice/discountPrice").and_then(|v| v.as_str()).map(|s| s.to_string());
            let curr = offer.pointer("/price/totalPrice/currencyCode").and_then(|v| v.as_str()).map(|s| s.to_string());
            let product_slug = offer.get("productSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
            let url_slug = offer.get("urlSlug").and_then(|v| v.as_str()).map(|s| s.to_string());

            items.push(StoreOfferItem {
                id: if offer_id.is_empty() { offer.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string() } else { offer_id },
                namespace: ns,
                title,
                description: None,
                cover,
                wide_art,
                seller,
                original_price: fmt_orig,
                discount_price: fmt_disc,
                discount_percentage: None,
                currency: curr.or_else(|| Some(country.clone())),
                product_slug,
                url_slug,
                page_slug: None,
                tags: vec!["İstek Listesi".into()],
            });
        }
    }

    Ok(items)
}

/// Epic Games resmi CDN'inden ücretsiz promosyonları çek
pub async fn fetch_free_games_promotions(country: &str) -> Result<(Vec<StoreFreeGameItem>, Vec<StoreFreeGameItem>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let locale = get_locale_for_country(country);
    let url = format!(
        "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale={locale}&country={country}&allowCountries={country}"
    );
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => {
            // Fallback to standard CDN URL
            let fb_url = format!(
                "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale={locale}&country={country}&allowCountries={country}"
            );
            client.get(&fb_url).send().await.map_err(|e| e.to_string())?
        }
    };

    if !resp.status().is_success() {
        return Err(format!("Promotions CDN HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut active = Vec::new();
    let mut upcoming = Vec::new();

    if let Some(elements) = json
        .pointer("/data/Catalog/searchStore/elements")
        .and_then(|v| v.as_array())
    {
        for el in elements {
            let title = el.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let id = el.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let namespace = el.get("namespace").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let description = el.get("description").and_then(|v| v.as_str()).unwrap_or_default().to_string();

            let mut cover = String::new();
            let mut wide_art = String::new();
            if let Some(images) = el.get("keyImages").and_then(|v| v.as_array()) {
                for img in images {
                    let itype = img.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                    let url = img.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    if itype.eq_ignore_ascii_case("OfferImageTall") || itype.eq_ignore_ascii_case("DieselStoreFrontTall") {
                        if cover.is_empty() { cover = url.clone(); }
                    } else if itype.eq_ignore_ascii_case("OfferImageWide") || itype.eq_ignore_ascii_case("DieselStoreFrontWide") {
                        if wide_art.is_empty() { wide_art = url.clone(); }
                    } else if cover.is_empty() && (itype.eq_ignore_ascii_case("Thumbnail") || itype.eq_ignore_ascii_case("ProductLogo")) {
                        cover = url.clone();
                    }
                }
            }

            let original_price = el.pointer("/price/totalPrice/fmtPrice/originalPrice")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let product_slug = el.get("productSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
            let url_slug = el.get("urlSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
            let page_slug = el.pointer("/offerMappings/0/pageSlug").and_then(|v| v.as_str()).map(|s| s.to_string());

            // 1. Şu an aktif ücretsiz promosyon kontrolü
            let mut is_active_free = false;
            let mut start_d: Option<String> = None;
            let mut end_d: Option<String> = None;

            if let Some(promo_offers) = el
                .pointer("/promotions/promotionalOffers")
                .and_then(|v| v.as_array())
            {
                for group in promo_offers {
                    if let Some(offers) = group.get("promotionalOffers").and_then(|v| v.as_array()) {
                        for off in offers {
                            let discount_percentage = off.pointer("/discountSetting/discountPercentage").and_then(|v| v.as_i64()).unwrap_or(-1);
                            let disc_price_num = el.pointer("/price/totalPrice/discountPrice").and_then(|v| v.as_i64()).unwrap_or(-1);
                            if discount_percentage == 0 || disc_price_num == 0 {
                                is_active_free = true;
                                start_d = off.get("startDate").and_then(|v| v.as_str()).map(|s| s.to_string());
                                end_d = off.get("endDate").and_then(|v| v.as_str()).map(|s| s.to_string());
                                break;
                            }
                        }
                    }
                    if is_active_free { break; }
                }
            }

            if is_active_free {
                active.push(StoreFreeGameItem {
                    id,
                    namespace,
                    title,
                    description,
                    cover,
                    wide_art,
                    original_price,
                    discount_price: Some("Ücretsiz".into()),
                    is_free_now: true,
                    start_date: start_d,
                    end_date: end_d,
                    product_slug,
                    url_slug,
                    page_slug,
                });
                continue;
            }

            // 2. Gelecek hafta ücretsiz promosyon kontrolü
            let mut is_upcoming_free = false;
            if let Some(upcoming_offers) = el
                .pointer("/promotions/upcomingPromotionalOffers")
                .and_then(|v| v.as_array())
            {
                for group in upcoming_offers {
                    if let Some(offers) = group.get("promotionalOffers").and_then(|v| v.as_array()) {
                        for off in offers {
                            let discount_percentage = off.pointer("/discountSetting/discountPercentage").and_then(|v| v.as_i64()).unwrap_or(-1);
                            if discount_percentage == 0 {
                                is_upcoming_free = true;
                                start_d = off.get("startDate").and_then(|v| v.as_str()).map(|s| s.to_string());
                                end_d = off.get("endDate").and_then(|v| v.as_str()).map(|s| s.to_string());
                                break;
                            }
                        }
                    }
                    if is_upcoming_free { break; }
                }
            }

            if is_upcoming_free {
                upcoming.push(StoreFreeGameItem {
                    id,
                    namespace,
                    title,
                    description,
                    cover,
                    wide_art,
                    original_price,
                    discount_price: Some("Yakında Ücretsiz".into()),
                    is_free_now: false,
                    start_date: start_d,
                    end_date: end_d,
                    product_slug,
                    url_slug,
                    page_slug,
                });
            }
        }
    }

    Ok((active, upcoming))
}

/// egdata.app JSON teklif nesnesini StoreOfferItem'e dönüştür
fn parse_egdata_offer(obj: &serde_json::Value) -> Option<StoreOfferItem> {
    let title = obj.get("title").and_then(|v| v.as_str())?.to_string();
    let id = obj.get("id").or_else(|| obj.get("_id")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let namespace = obj.get("namespace").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let description = obj.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());

    let mut cover = String::new();
    let mut wide_art = String::new();
    if let Some(images) = obj.get("keyImages").and_then(|v| v.as_array()) {
        for img in images {
            let itype = img.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            let url = img.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if itype.eq_ignore_ascii_case("OfferImageTall") || itype.eq_ignore_ascii_case("DieselStoreFrontTall") {
                if cover.is_empty() { cover = url.clone(); }
            } else if itype.eq_ignore_ascii_case("OfferImageWide") || itype.eq_ignore_ascii_case("DieselStoreFrontWide") {
                if wide_art.is_empty() { wide_art = url.clone(); }
            } else if cover.is_empty() && (itype.eq_ignore_ascii_case("Thumbnail") || itype.eq_ignore_ascii_case("featuredMedia")) {
                cover = url.clone();
            }
        }
    }

    let seller = obj.pointer("/seller/name")
        .or_else(|| obj.get("developerDisplayName"))
        .or_else(|| obj.pointer("/seller"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let product_slug = obj.get("productSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
    let url_slug = obj.get("urlSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
    let page_slug = obj.pointer("/offerMappings/0/pageSlug").and_then(|v| v.as_str()).map(|s| s.to_string());

    let mut tags = Vec::new();
    if let Some(tag_arr) = obj.get("tags").and_then(|v| v.as_array()) {
        for t in tag_arr {
            if let Some(name) = t.get("name").and_then(|v| v.as_str()) {
                tags.push(name.to_string());
            }
        }
    }

    let mut original_price = None;
    let mut discount_price = None;
    let mut discount_percentage = None;
    let mut currency = None;

    if let Some(p_obj) = obj.get("price") {
        if let Some(price_rec) = p_obj.get("price") {
            let curr = price_rec.get("currencyCode").and_then(|v| v.as_str()).unwrap_or("TRY");
            currency = Some(curr.to_string());
            let orig = price_rec.get("originalPrice").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
            let disc = price_rec.get("discountPrice").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
            if orig > 0.0 {
                original_price = Some(format_currency(orig, curr));
            }
            if disc > 0.0 {
                discount_price = Some(format_currency(disc, curr));
            } else if orig > 0.0 && disc == 0.0 {
                discount_price = Some("Ücretsiz".into());
            }
            // Yüzde, gösterilen fiyatlarla tutarlı olmalı (appliedRules güvenilmez)
            discount_percentage = discount_pct_from_prices(orig, disc);
        }
    }

    Some(StoreOfferItem {
        id,
        namespace,
        title,
        description,
        cover,
        wide_art,
        seller,
        original_price,
        discount_price,
        discount_percentage,
        currency,
        product_slug,
        url_slug,
        page_slug,
        tags,
    })
}

/// egdata.app'den çok satanları çek
pub async fn fetch_top_sellers(country: &str) -> Result<Vec<StoreOfferItem>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.egdata.app/offers/top-sellers?limit=24&country={country}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Top sellers HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut offers = Vec::new();

    let elements = json.get("elements").or_else(|| json.as_array().map(|_| &json));
    if let Some(arr) = elements.and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(parsed) = parse_egdata_offer(item) {
                offers.push(parsed);
            }
        }
    }

    Ok(offers)
}

/// egdata.app'den öne çıkan indirimleri çek
pub async fn fetch_featured_discounts(country: &str) -> Result<Vec<StoreOfferItem>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.egdata.app/offers/featured-discounts?country={country}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Discounts HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut offers = Vec::new();

    if let Some(arr) = json.as_array() {
        for item in arr {
            if let Some(parsed) = parse_egdata_offer(item) {
                offers.push(parsed);
            }
        }
    }

    Ok(offers)
}

/// egdata.app'den yakında çıkacak oyunları çek
pub async fn fetch_upcoming_offers(country: &str) -> Result<Vec<StoreOfferItem>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.egdata.app/offers/upcoming?limit=24&country={country}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Upcoming HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut offers = Vec::new();

    let elements = json.get("elements").or_else(|| json.as_array().map(|_| &json));
    if let Some(arr) = elements.and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(parsed) = parse_egdata_offer(item) {
                offers.push(parsed);
            }
        }
    }

    Ok(offers)
}

/// egdata.app OpenSearch üzerinden mağazada oyun ara
pub async fn search_store_offers(query: &str, country: &str) -> Result<Vec<StoreOfferItem>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "title": q,
        "limit": 24
    });

    let url = format!("https://api.egdata.app/search/v2/search?country={country}");
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Search HTTP {}", resp.status().as_u16()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut offers = Vec::new();

    if let Some(arr) = json.get("offers").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(parsed) = parse_egdata_offer(item) {
                offers.push(parsed);
            }
        }
    }

    Ok(offers)
}

/* =============================================================
   ZENGİN ÜRÜN SAYFASI İÇERİĞİ (Akamai CDN `content/products/<slug>`)
   ============================================================= */

/// Etiketleri normalize ederek anahtar üretir: "Online Multiplayer" -> "onlinemultiplayer"
fn tag_key(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Oynanış özelliği etiketini Türkçe karşılığına çevirir (yoksa None).
fn feature_label(raw: &str) -> Option<&'static str> {
    let k = tag_key(raw);
    let label = match k.as_str() {
        "singleplayer" => "Tek Oyunculu",
        "multiplayer" => "Çok Oyunculu",
        "onlinemultiplayer" => "Çevrimiçi Çok Oyunculu",
        "localmultiplayer" => "Yerel Çok Oyunculu",
        "coop" | "cooperative" => "Co-op",
        "onlinecoop" => "Çevrimiçi Co-op",
        "localcoop" => "Yerel Co-op",
        "achievements" => "Başarımlar",
        "cloudsaves" | "cloudsave" | "cloud" => "Bulut Kayıt",
        "crossplatform" | "crossplay" => "Platformlar Arası",
        "crosssaves" | "crosssave" => "Platformlar Arası Kayıt",
        "controllersupport" | "controller" | "gamepad" | "fullcontrollersupport" => "Oyun Kolu Desteği",
        "competitive" => "Rekabetçi",
        "leaderboards" => "Liderlik Tabloları",
        "voicechat" => "Sesli Sohbet",
        "vr" | "vrsupport" | "vrcompatible" => "VR Desteği",
        "earlyaccess" => "Erken Erişim",
        "freetoplay" => "Ücretsiz Oynanış",
        "modsupport" | "mods" => "Mod Desteği",
        "anticheat" => "Hile Koruması",
        "leveleditor" => "Seviye Editörü",
        _ => return None,
    };
    Some(label)
}

/// Platform etiketi mi? (tür listesine girmemeli)
fn is_platform_tag(raw: &str) -> Option<&'static str> {
    match tag_key(raw).as_str() {
        "windows" | "win32" | "pc" | "windows10" | "windows11" => Some("Windows"),
        "mac" | "macos" | "osx" => Some("Mac"),
        "linux" => Some("Linux"),
        "ios" => Some("iOS"),
        "android" => Some("Android"),
        _ => None,
    }
}

/// Gürültülü pazarlama/kampanya etiketleri (tür olarak gösterilmez)
fn is_noise_tag(raw: &str) -> bool {
    matches!(
        tag_key(raw).as_str(),
        "promotionalcontent"
            | "eaplay"
            | "eaplaydiscount"
            | "refundable"
            | "selfrefundable"
            | "denuvo"
            | "basegame"
            | "edition"
            | "dlc"
            | "addon"
            | "bundle"
            | "seasonpass"
            | "prepurchase"
            | "comingsoon"
            | "newrelease"
            | "mostplayed"
    )
}

/// Ham etiket listesini (tür, özellik, platform) üçlüsüne ayırır.
/// Hem Epic'in ALL_CAPS etiketleri hem egdata'nın okunabilir adları desteklenir.
pub fn classify_tags(raw: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut genres: Vec<String> = Vec::new();
    let mut features: Vec<String> = Vec::new();
    let mut platforms: Vec<String> = Vec::new();

    for t in raw {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(p) = is_platform_tag(t) {
            if !platforms.iter().any(|x| x == p) {
                platforms.push(p.to_string());
            }
            continue;
        }
        if let Some(f) = feature_label(t) {
            if !features.iter().any(|x| x == f) {
                features.push(f.to_string());
            }
            continue;
        }
        if is_noise_tag(t) {
            continue;
        }
        // ALL_CAPS etiketleri okunabilir hale getir
        let pretty = if t.len() >= 2 && t.chars().all(|c| !c.is_lowercase()) {
            let mut out = String::new();
            for (i, part) in t.split('_').filter(|p| !p.is_empty()).enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                let mut cs = part.chars();
                if let Some(f) = cs.next() {
                    out.push(f);
                    out.extend(cs.flat_map(|c| c.to_lowercase()));
                }
            }
            out
        } else {
            t.to_string()
        };
        if !genres.iter().any(|x| x.eq_ignore_ascii_case(&pretty)) {
            genres.push(pretty);
        }
    }

    (genres, features, platforms)
}

/// Markdown/HTML artıklarını temizler; anlamlı metin kalmazsa None döner.
fn clean_rich_text(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut in_comment = false;
    for line in raw.lines() {
        let mut line = line.trim().to_string();
        // HTML yorumlarını (çok satırlı olabilir) atla
        if in_comment {
            if let Some(pos) = line.find("-->") {
                line = line[pos + 3..].to_string();
                in_comment = false;
            } else {
                continue;
            }
        }
        while let Some(start) = line.find("<!--") {
            if let Some(rel_end) = line[start..].find("-->") {
                line.replace_range(start..start + rel_end + 3, " ");
            } else {
                line.truncate(start);
                in_comment = true;
                break;
            }
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Yalnızca görsel/video satırlarını atla
        if line.starts_with("![") || line.starts_with("<img") || line.starts_with("<video") {
            continue;
        }
        // Markdown başlık işaretlerini temizle
        let cleaned = line.trim_start_matches('#').trim();
        let cleaned = cleaned.trim_matches('*').trim();
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(cleaned);
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// `video.recipes` JSON dizesinden fragman kapak görselini çıkarır.
fn trailer_thumb_from_recipes(recipes: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(recipes).ok()?;
    let obj = parsed.as_object()?;
    for (_locale, arr) in obj.iter() {
        for recipe in arr.as_array()? {
            if let Some(outputs) = recipe.get("outputs").and_then(|o| o.as_array()) {
                for out in outputs {
                    let key = out.get("key").and_then(|k| k.as_str()).unwrap_or_default();
                    if key.eq_ignore_ascii_case("thumbnail") {
                        if let Some(u) = out.get("url").and_then(|u| u.as_str()) {
                            return Some(u.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// `video.recipes` içinden oynatılabilir manifest adresini (mpd/m3u8) çıkarır.
fn trailer_manifest_from_recipes(recipes: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(recipes).ok()?;
    let obj = parsed.as_object()?;
    for (_locale, arr) in obj.iter() {
        for recipe in arr.as_array()? {
            if let Some(outputs) = recipe.get("outputs").and_then(|o| o.as_array()) {
                for out in outputs {
                    let key = out.get("key").and_then(|k| k.as_str()).unwrap_or_default();
                    if key.eq_ignore_ascii_case("manifest") {
                        if let Some(u) = out.get("url").and_then(|u| u.as_str()) {
                            return Some(u.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Akamai CDN ürün içeriğini ayrıştırır (saf fonksiyon — test edilebilir).
pub fn parse_cdn_page(body: &serde_json::Value, slug: &str, country: &str) -> Option<StorePageContent> {
    let pages = body.get("pages").and_then(|p| p.as_array())?;
    let page = pages
        .iter()
        .find(|p| p.get("_slug").and_then(|s| s.as_str()) == Some("home"))
        .or_else(|| pages.iter().find(|p| p.get("data").and_then(|d| d.get("about")).is_some()))?;
    let data = page.get("data")?;

    let mut out = StorePageContent {
        slug: slug.to_string(),
        ..Default::default()
    };

    // --- Hakkında ---
    if let Some(about) = data.get("about") {
        out.about_title = about
            .get("title")
            .and_then(|v| v.as_str())
            .and_then(clean_rich_text);
        out.about_short = about
            .get("shortDescription")
            .and_then(|v| v.as_str())
            .and_then(clean_rich_text);
        out.about_image = about
            .pointer("/image/src")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }

    // --- Hero ---
    if let Some(hero) = data.get("hero") {
        out.hero_logo = hero
            .pointer("/logoImage/src")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        out.hero_wide = hero
            .get("backgroundImageUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        out.hero_portrait = hero
            .get("portraitBackgroundImageUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }

    // --- Medya galerisi (ekran görüntüleri + fragmanlar) ---
    if let Some(items) = data.pointer("/carousel/items").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(src) = item
                .pointer("/image/src")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                out.media.push(StoreMediaItem {
                    kind: "image".into(),
                    thumb: src.to_string(),
                    full: src.to_string(),
                    caption: item
                        .pointer("/image/altText")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
                continue;
            }
            let video = item.get("video");
            let recipes = video
                .and_then(|v| v.get("recipes"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if recipes.is_empty() {
                continue;
            }
            if let Some(thumb) = trailer_thumb_from_recipes(recipes) {
                out.media.push(StoreMediaItem {
                    kind: "trailer".into(),
                    thumb,
                    full: trailer_manifest_from_recipes(recipes).unwrap_or_default(),
                    caption: video
                        .and_then(|v| v.get("title"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }

    // --- Sistem gereksinimleri + diller ---
    if let Some(reqs) = data.get("requirements") {
        if let Some(langs) = reqs.get("languages").and_then(|l| l.as_array()) {
            for l in langs {
                if let Some(s) = l.as_str() {
                    if !s.trim().is_empty() {
                        out.languages.push(s.trim().to_string());
                    }
                }
            }
        }
        if let Some(sys_arr) = reqs.get("systems").and_then(|s| s.as_array()) {
            for sys_val in sys_arr {
                let sys_type = sys_val
                    .get("systemType")
                    .and_then(|t| t.as_str())
                    .unwrap_or("Windows")
                    .to_string();
                let mut details = Vec::new();
                if let Some(det_arr) = sys_val.get("details").and_then(|d| d.as_array()) {
                    for det in det_arr {
                        let title = det
                            .get("title")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if title.is_empty() {
                            continue;
                        }
                        let norm = |k: &str| {
                            det.get(k)
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                        };
                        let minimum = norm("minimum");
                        let recommended = norm("recommended");
                        if minimum.is_none() && recommended.is_none() {
                            continue;
                        }
                        details.push(super::models::SystemDetailItem {
                            title,
                            minimum,
                            recommended,
                        });
                    }
                }
                if !details.is_empty() {
                    out.requirements.push(SystemRequirement {
                        system_type: sys_type,
                        details,
                    });
                }
            }
        }
    }

    // --- Künye ---
    if let Some(meta) = data.get("meta") {
        if let Some(arr) = meta.get("platform").and_then(|v| v.as_array()) {
            for p in arr {
                if let Some(s) = p.as_str() {
                    if let Some(norm) = is_platform_tag(s) {
                        if !out.platforms.iter().any(|x| x == norm) {
                            out.platforms.push(norm.to_string());
                        }
                    } else if !s.trim().is_empty() {
                        out.platforms.push(s.trim().to_string());
                    }
                }
            }
        }
        if let Some(arr) = meta.get("tags").and_then(|v| v.as_array()) {
            let raw: Vec<String> = arr
                .iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect();
            let (g, f, p) = classify_tags(&raw);
            out.genres.extend(g);
            out.features.extend(f);
            for pl in p {
                if !out.platforms.iter().any(|x| x == &pl) {
                    out.platforms.push(pl);
                }
            }
        }
    }

    // --- Yaş sınıflandırması (ülkeye uyan puanlama rozeti) ---
    if let Some(ratings) = body.pointer("/productRatings/ratings").and_then(|v| v.as_array()) {
        let cc = country.to_uppercase();
        let pick = ratings
            .iter()
            .find(|r| {
                r.get("countryCodes")
                    .and_then(|c| c.as_str())
                    .map(|codes| codes.split(',').any(|c| c.trim().eq_ignore_ascii_case(&cc)))
                    .unwrap_or(false)
            })
            .or_else(|| {
                ratings.iter().find(|r| {
                    r.get("title")
                        .and_then(|t| t.as_str())
                        .map(|t| t.to_uppercase().contains("PEGI"))
                        .unwrap_or(false)
                })
            });
        if let Some(r) = pick {
            out.age_rating = r
                .get("title")
                .and_then(|t| t.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }

    // --- Sosyal / resmi bağlantılar ---
    if let Some(social) = data.get("socialLinks") {
        const SOCIAL_MAP: &[(&str, &str)] = &[
            ("linkHomepage", "Resmi Site"),
            ("linkTwitter", "X / Twitter"),
            ("linkFacebook", "Facebook"),
            ("linkYoutube", "YouTube"),
            ("linkInstagram", "Instagram"),
            ("linkTwitch", "Twitch"),
            ("linkDiscord", "Discord"),
        ];
        for (key, label) in SOCIAL_MAP {
            if let Some(u) = social.get(*key).and_then(|v| v.as_str()) {
                if !u.trim().is_empty() {
                    out.links.push(StoreLink {
                        label: (*label).to_string(),
                        url: u.trim().to_string(),
                    });
                }
            }
        }
    }

    // --- Edisyon/DLC rozetleri için uzun açıklama (egdata yoksa yedek) ---
    if let Some(desc) = data
        .pointer("/about/description")
        .and_then(|v| v.as_str())
        .and_then(clean_rich_text)
    {
        if !desc.is_empty() {
            out.about_long = Some(desc);
        }
    }

    if out.media.is_empty()
        && out.requirements.is_empty()
        && out.about_short.is_none()
        && out.about_long.is_none()
    {
        return None;
    }

    Some(out)
}

fn page_cache_path(slug: &str, locale: &str) -> PathBuf {
    default_config_dir()
        .join("store_pages")
        .join(format!("{}_{}.json", locale, slug))
}

/// Önbellek dosyasının yaşını saniye cinsinden döndürür (yoksa None).
fn cache_age_secs(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    SystemTime::now().duration_since(modified).ok().map(|d| d.as_secs())
}

/// Önbellek içeriğinin "bu slug CDN'de yok" işareti olup olmadığını söyler.
fn is_cache_miss(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|v| v.get("_miss").and_then(|m| m.as_bool()))
        .unwrap_or(false)
}

/// Bulunamayan slug'lar için negatif önbellek yazar.
///
/// ÖNEMLİ: CDN kataloğu ürünlerin yalnızca ~%33'ünü kapsar. Negatif önbellek
/// olmadan her ürün sayfası açılışında boşa giden HTTP denemeleri yapılır ve
/// ağ yavaşsa sayfa onlarca saniye "yükleniyor" durumunda kalır.
fn write_page_miss(cache_file: &Path) {
    if let Some(parent) = cache_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        cache_file,
        format!("{{\"_miss\":true,\"at\":{}}}", current_timestamp()),
    );
}

const PAGE_TTL_SECS: u64 = 7 * 24 * 3600;
const PAGE_MISS_TTL_SECS: u64 = 6 * 3600;
const PAGE_FETCH_TIMEOUT_SECS: u64 = 6;

/// Akamai CDN ürün içeriğini diskten okur (başarı 7 gün, başarısızlık 6 saat
/// önbelleklenir) veya çeker. Bulunamazsa `None` döner — bu bir hata değildir.
pub async fn fetch_store_page_content(slug: &str, locale: &str) -> Option<StorePageContent> {
    if slug.trim().is_empty() {
        return None;
    }
    let cache_file = page_cache_path(slug, locale);

    if let Some(age) = cache_age_secs(&cache_file) {
        if let Ok(content) = fs::read_to_string(&cache_file) {
            // Negatif önbellek: yakın zamanda bulunamadı, tekrar denemeye değmez
            if is_cache_miss(&content) {
                if age < PAGE_MISS_TTL_SECS {
                    return None;
                }
            } else if age < PAGE_TTL_SECS {
                if let Ok(cached) = serde_json::from_str::<StorePageContent>(&content) {
                    return Some(cached);
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PAGE_FETCH_TIMEOUT_SECS))
        .build()
        .ok()?;

    let url = format!(
        "https://store-content-ipv4.ak.epicgames.com/api/{}/content/products/{}",
        locale, slug
    );
    let resp = match client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await
    {
        Ok(r) => r,
        // Ağ hatasında negatif önbellek yazma: geçici olabilir
        Err(_) => return None,
    };
    if !resp.status().is_success() {
        write_page_miss(&cache_file);
        return None;
    }
    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return None,
    };
    let body: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return None,
    };

    let parsed = match parse_cdn_page(&body, slug, &locale_country(locale)) {
        Some(p) => p,
        None => {
            write_page_miss(&cache_file);
            return None;
        }
    };

    if let Some(parent) = cache_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json_str) = serde_json::to_string(&parsed) {
        let _ = fs::write(&cache_file, json_str);
    }
    Some(parsed)
}

/// Yerel ayardan ülke koduna göre puanlama rozetini seçmek için yardımcı.
fn locale_country(locale: &str) -> String {
    locale
        .split('-')
        .next_back()
        .unwrap_or("TR")
        .to_uppercase()
}

/// egdata.app üzerinden tekil oyun detayını (ürün sayfası) çek
pub async fn fetch_store_offer_detail(offer_id: &str, country: &str) -> Result<StoreOfferDetail, String> {
    let locale = get_locale_for_country(country);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let offer_url = format!("https://api.egdata.app/offers/{offer_id}?country={country}");
    let price_url = format!("https://api.egdata.app/offers/{offer_id}/price?country={country}");

    let offer_res = client.get(&offer_url).send().await;
    let price_res = client.get(&price_url).send().await;

    let offer_resp = offer_res.map_err(|e| format!("Offer HTTP hatası: {e}"))?;
    if !offer_resp.status().is_success() {
        return Err(format!("Offer HTTP {}", offer_resp.status().as_u16()));
    }
    let offer_text = offer_resp.text().await.map_err(|e| e.to_string())?;
    let offer_json: serde_json::Value = serde_json::from_str(&offer_text).map_err(|e| e.to_string())?;

    let id = offer_json.get("id").or_else(|| offer_json.get("_id")).and_then(|v| v.as_str()).unwrap_or(offer_id).to_string();
    let namespace = offer_json.get("namespace").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let title = offer_json.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let description = offer_json.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let long_description = offer_json.get("longDescription").and_then(|v| v.as_str()).map(|s| s.to_string());
    let developer = offer_json.get("developerDisplayName").and_then(|v| v.as_str()).map(|s| s.to_string());
    let publisher = offer_json.get("publisherDisplayName").and_then(|v| v.as_str()).map(|s| s.to_string());
    let release_date = offer_json.get("releaseDate")
        .or_else(|| offer_json.get("pcReleaseDate"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut cover = String::new();
    let mut wide_art = String::new();
    let mut screenshots = Vec::new();

    if let Some(images) = offer_json.get("keyImages").and_then(|v| v.as_array()) {
        for img in images {
            let itype = img.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            let url = img.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            if itype.eq_ignore_ascii_case("OfferImageTall") || itype.eq_ignore_ascii_case("DieselStoreFrontTall") {
                if cover.is_empty() { cover = url.clone(); }
            } else if itype.eq_ignore_ascii_case("OfferImageWide") || itype.eq_ignore_ascii_case("DieselStoreFrontWide") {
                if wide_art.is_empty() { wide_art = url.clone(); }
            } else if itype.eq_ignore_ascii_case("featuredMedia") || itype.eq_ignore_ascii_case("Screenshot") {
                if !screenshots.contains(&url) {
                    screenshots.push(url);
                }
            } else if cover.is_empty() && (itype.eq_ignore_ascii_case("Thumbnail") || itype.eq_ignore_ascii_case("ProductLogo")) {
                cover = url.clone();
            }
        }
    }
    if cover.is_empty() && !screenshots.is_empty() {
        cover = screenshots[0].clone();
    }
    if wide_art.is_empty() && !screenshots.is_empty() {
        wide_art = screenshots[0].clone();
    }

    let product_slug = offer_json.get("productSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
    let url_slug = offer_json.get("urlSlug").and_then(|v| v.as_str()).map(|s| s.to_string());
    let page_slug = offer_json.pointer("/offerMappings/0/pageSlug").and_then(|v| v.as_str()).map(|s| s.to_string());

    let mut tags = Vec::new();
    if let Some(tag_arr) = offer_json.get("tags").and_then(|v| v.as_array()) {
        for t in tag_arr {
            if let Some(name) = t.get("name").and_then(|v| v.as_str()) {
                tags.push(name.to_string());
            }
        }
    }

    // Fiyat ve indirim bilgisi
    let mut original_price = None;
    let mut discount_price = None;
    let mut discount_percentage = None;
    let mut currency = None;

    if let Ok(p_resp) = price_res {
        if p_resp.status().is_success() {
            if let Ok(p_text) = p_resp.text().await {
                if let Ok(p_json) = serde_json::from_str::<serde_json::Value>(&p_text) {
                if let Some(price_rec) = p_json.get("price") {
                    let curr = price_rec.get("currencyCode").and_then(|v| v.as_str()).unwrap_or("TRY");
                    currency = Some(curr.to_string());
                    let orig = price_rec.get("originalPrice").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
                    let disc = price_rec.get("discountPrice").and_then(|v| v.as_f64()).unwrap_or(0.0) / 100.0;
                    if orig > 0.0 {
                        original_price = Some(format_currency(orig, curr));
                    }
                    if disc > 0.0 {
                        discount_price = Some(format_currency(disc, curr));
                    } else if orig > 0.0 && disc == 0.0 {
                        discount_price = Some("Ücretsiz".into());
                    }
                }
                if let Some(rules) = p_json.get("appliedRules").and_then(|v| v.as_array()) {
                    if let Some(first) = rules.first() {
                        discount_percentage = first.pointer("/discountSetting/discountPercentage").and_then(|v| v.as_i64());
                    }
                }
                }
            }
        }
    }

    let is_in_wishlist = read_local_wishlist().contains(&id);
    let is_in_cart = read_local_cart().contains(&id);

    // --- Tür / özellik / platform ayrımı (egdata etiketlerinden) ---
    let (mut genres, features, mut platforms) = classify_tags(&tags);

    // --- Zengin ürün sayfası içeriğini CDN'den çek (varsa) ---
    // Deneme sayısı SINIRLIDIR. CDN kataloğu ürünlerin yalnızca ~%33'ünü kapsar;
    // aday listesinin tamamını (eskiden 4 aday × 2 dil = 8 istek) yoklamak, ağ
    // yavaşken ürün sayfasını onlarca saniye "yükleniyor" durumunda bırakıyordu.
    let candidates = build_slug_candidates(&title, page_slug.as_deref(), product_slug.as_deref(), url_slug.as_deref());
    let mut page = None;
    let mut resolved_slug = None;
    for cand in candidates.iter().take(MAX_CDN_SLUG_TRIES) {
        if let Some(content) = fetch_store_page_content(cand, locale).await {
            resolved_slug = Some(cand.clone());
            page = Some(content);
            break;
        }
    }
    // Kullanıcının dilinde bulunamazsa en olası aday için bir kez İngilizce dene
    if page.is_none() && locale != "en-US" {
        if let Some(first) = candidates.first() {
            if let Some(content) = fetch_store_page_content(first, "en-US").await {
                resolved_slug = Some(first.clone());
                page = Some(content);
            }
        }
    }

    let (hero_logo, about_image, media, requirements, languages, age_rating, links, page_long) =
        match page {
            Some(p) => {
                for g in &p.genres {
                    if !genres.iter().any(|x| x.eq_ignore_ascii_case(g)) {
                        genres.push(g.clone());
                    }
                }
                for pl in &p.platforms {
                    if !platforms.iter().any(|x| x == pl) {
                        platforms.push(pl.clone());
                    }
                }
                // egdata görsel listesi boşsa CDN galerisinden doldur
                if screenshots.is_empty() {
                    screenshots = p
                        .media
                        .iter()
                        .filter(|m| m.kind == "image")
                        .map(|m| m.full.clone())
                        .collect();
                }
                (
                    p.hero_logo,
                    p.about_image,
                    p.media,
                    p.requirements,
                    p.languages,
                    p.age_rating,
                    p.links,
                    p.about_long,
                )
            }
            None => (None, None, Vec::new(), Vec::new(), Vec::new(), None, Vec::new(), None),
        };

    let has_page_content = !media.is_empty() || !requirements.is_empty() || about_image.is_some();

    // Uzun açıklama: egdata metni yoksa CDN metnine düş
    let long_description = long_description.or(page_long).and_then(|s| clean_rich_text(&s));

    // Görsel yedekleri: hero ve kapak alanlarını boş bırakma
    let cover = if cover.is_empty() {
        screenshots.first().cloned().unwrap_or_default()
    } else {
        cover
    };
    let wide_art = if wide_art.is_empty() {
        screenshots.first().cloned().unwrap_or(cover.clone())
    } else {
        wide_art
    };

    Ok(StoreOfferDetail {
        id,
        namespace,
        title,
        description,
        long_description,
        cover,
        wide_art,
        screenshots,
        developer,
        publisher,
        release_date,
        original_price,
        discount_price,
        discount_percentage,
        currency,
        product_slug,
        url_slug,
        page_slug,
        tags,
        is_in_wishlist,
        is_in_cart,
        genres,
        features,
        platforms,
        age_rating,
        about_image,
        hero_logo,
        media,
        requirements,
        languages,
        links,
        has_page_content,
        resolved_slug,
    })
}

/// Ürün sayfası içeriği için en fazla kaç slug adayı denenecek.
/// (Her deneme bir HTTP isteğidir; sayfa açılışını geciktirmemek için düşük tutulur.)
const MAX_CDN_SLUG_TRIES: usize = 2;

/// Mağaza slug'ı gibi görünüyor mu? (32 karakterlik hex hash'leri eler)
fn is_probable_slug(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 2 || t.len() > 80 {
        return false;
    }
    if t.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    t.chars().any(|c| c.is_ascii_alphabetic())
}

/// CDN ürün sayfası için aday slug listesi (en olasıdan başlar).
pub fn build_slug_candidates(
    title: &str,
    page_slug: Option<&str>,
    product_slug: Option<&str>,
    url_slug: Option<&str>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let s = s.trim();
        if is_probable_slug(s) && !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    };
    if let Some(s) = page_slug {
        push(s);
    }
    if let Some(s) = product_slug {
        push(s);
        // productSlug bazen "/tr/p/xxx" biçiminde gelir
        if let Some(last) = s.rsplit('/').next() {
            push(last);
        }
    }
    if let Some(s) = url_slug {
        push(s);
    }
    for c in super::commands::generate_slug_candidates(title, None, None) {
        push(&c);
    }
    out.truncate(4);
    out
}

/// Tüm mağaza verilerini birleştiren ve diskte önbellekleyen ana fonksiyon
pub async fn get_store_hub(force_refresh: bool) -> Result<StoreHubResponse, String> {
    let cache_path = cache_file_path();
    let config = default_config_dir();
    let country = get_user_country(&config);
    let now = current_timestamp();

    // 1. Disk önbelleğini kontrol et (30 dakika geçerli, aynı ülke olmalı)
    if !force_refresh && cache_path.is_file() {
        if let Ok(content) = fs::read_to_string(&cache_path) {
            if let Ok(mut cached) = serde_json::from_str::<StoreHubResponse>(&content) {
                // Ülke uyuşuyorsa ve 30 dk geçmediyse önbellekten dön
                if cached.country == country && now.saturating_sub(cached.updated_at) < 1800 {
                    let mut local_wishlist = read_local_wishlist();
                    let local_cart = read_local_cart();
                    for id in &cached.wishlist_offer_ids {
                        local_wishlist.insert(id.clone());
                    }
                    cached.wishlist_offer_ids = local_wishlist.into_iter().collect();
                    cached.cart_offer_ids = local_cart.into_iter().collect();
                    return Ok(cached);
                }
            }
        }
    }

    // 2. Ağ isteklerini doğru ülke parametresiyle çek
    let (free_active, free_upcoming) = fetch_free_games_promotions(&country).await.unwrap_or_default();
    let top_sellers = fetch_top_sellers(&country).await.unwrap_or_default();
    let featured_discounts = fetch_featured_discounts(&country).await.unwrap_or_default();
    let upcoming_offers = fetch_upcoming_offers(&country).await.unwrap_or_default();

    // 3. Kullanıcı istek listesini GraphQL'den çekmeyi dene
    let user_wishlist = fetch_epic_user_wishlist(&config).await.unwrap_or_default();

    let mut all_wishlist_ids = read_local_wishlist();
    for item in user_wishlist {
        if !item.id.is_empty() {
            all_wishlist_ids.insert(item.id);
        }
    }

    let cart_ids: Vec<String> = read_local_cart().into_iter().collect();

    let response = StoreHubResponse {
        country,
        free_games_active: free_active,
        free_games_upcoming: free_upcoming,
        top_sellers,
        featured_discounts,
        upcoming_offers,
        wishlist_offer_ids: all_wishlist_ids.into_iter().collect(),
        cart_offer_ids: cart_ids,
        updated_at: now,
    };

    // 4. Diske önbellekle
    if let Ok(json_str) = serde_json::to_string_pretty(&response) {
        let _ = fs::write(&cache_path, json_str);
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_currency_try() {
        assert_eq!(format_currency(391.30, "TRY"), "₺391,30");
        assert_eq!(format_currency(1999.00, "TRY"), "₺1.999,00");
        assert_eq!(format_currency(0.00, "TRY"), "₺0,00");
    }

    #[test]
    fn test_format_currency_eur_usd() {
        assert_eq!(format_currency(49.99, "EUR"), "49,99 €");
        assert_eq!(format_currency(1499.50, "EUR"), "1.499,50 €");
        assert_eq!(format_currency(59.99, "USD"), "$59.99");
        assert_eq!(format_currency(1299.99, "USD"), "$1,299.99");
    }

    #[test]
    fn test_parse_egdata_offer_structure() {
        let sample = serde_json::json!({
            "id": "test-offer-123",
            "namespace": "test-ns",
            "title": "Cyberpunk 2077",
            "description": "An open-world action RPG",
            "keyImages": [
                {
                    "type": "OfferImageTall",
                    "url": "https://cdn.epicgames.com/tall.jpg"
                },
                {
                    "type": "OfferImageWide",
                    "url": "https://cdn.epicgames.com/wide.jpg"
                }
            ],
            "price": {
                "price": {
                    "currencyCode": "TRY",
                    "originalPrice": 199900,
                    "discountPrice": 99900
                },
                "appliedRules": [
                    {
                        "discountSetting": {
                            "discountPercentage": 50
                        }
                    }
                ]
            },
            "tags": [
                { "name": "Action" },
                { "name": "RPG" }
            ]
        });

        let item = parse_egdata_offer(&sample).expect("Parse başarısız olmamalı");
        assert_eq!(item.id, "test-offer-123");
        assert_eq!(item.title, "Cyberpunk 2077");
        assert_eq!(item.cover, "https://cdn.epicgames.com/tall.jpg");
        assert_eq!(item.wide_art, "https://cdn.epicgames.com/wide.jpg");
        assert_eq!(item.original_price.as_deref(), Some("₺1.999,00"));
        assert_eq!(item.discount_price.as_deref(), Some("₺999,00"));
        assert_eq!(item.discount_percentage, Some(50));
        assert_eq!(item.tags, vec!["Action", "RPG"]);
    }

    #[test]
    fn test_toggle_wishlist_set() {
        let mut list = HashSet::new();
        list.insert("item1".to_string());

        // Toggle out
        list.remove("item1");
        assert!(!list.contains("item1"));

        // Toggle in
        list.insert("item1".to_string());
        assert!(list.contains("item1"));
    }

    /// egdata'nın okunabilir etiketleri tür/özellik/platform olarak ayrılmalı.
    #[test]
    fn test_classify_tags_egdata_style() {
        let raw: Vec<String> = ["Co-op", "Online Multiplayer", "Simulation", "Sports", "Achievements", "Single Player", "Windows"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (genres, features, platforms) = classify_tags(&raw);
        assert_eq!(genres, vec!["Simulation", "Sports"]);
        assert!(features.contains(&"Co-op".to_string()));
        assert!(features.contains(&"Tek Oyunculu".to_string()));
        assert!(features.contains(&"Başarımlar".to_string()));
        assert_eq!(platforms, vec!["Windows"]);
    }

    /// Epic'in ALL_CAPS etiketleri okunabilir hale gelmeli, gürültü elenmeli.
    #[test]
    fn test_classify_tags_epic_caps() {
        let raw: Vec<String> = ["RPG", "SINGLE_PLAYER", "ACTION", "Promotional Content", "CLOUD_SAVES", "Mac"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (genres, features, platforms) = classify_tags(&raw);
        assert!(genres.contains(&"Rpg".to_string()));
        assert!(genres.contains(&"Action".to_string()));
        assert!(!genres.iter().any(|g| g.contains("Promotional")));
        assert!(features.contains(&"Tek Oyunculu".to_string()));
        assert!(features.contains(&"Bulut Kayıt".to_string()));
        assert_eq!(platforms, vec!["Mac"]);
    }

    #[test]
    fn test_clean_rich_text_strips_markup() {
        let raw = "<!--textBlock-->\n<!--title-->\n# Pre-Purchase Game\n![Gif1](https://x/a.gif)\n\nReal paragraph here.";
        let out = clean_rich_text(raw).unwrap();
        assert!(out.contains("Pre-Purchase Game"));
        assert!(out.contains("Real paragraph here."));
        assert!(!out.contains("<!--"));
        assert!(!out.contains("!["));
        // Yalnızca görsel içeren metin None dönmeli
        assert!(clean_rich_text("![a](b.png)\n![c](d.png)").is_none());
    }

    /// Negatif önbellek işareti gerçek içerikten ayırt edilebilmeli.
    /// (Aksi halde "bulunamadı" kaydı geçerli içerik sanılır veya tersi olur.)
    #[test]
    fn test_cache_miss_marker_detection() {
        assert!(is_cache_miss(r#"{"_miss":true,"at":1758200000}"#));
        assert!(!is_cache_miss(r#"{"slug":"cyberpunk-2077","media":[]}"#));
        assert!(!is_cache_miss("bozuk json"));
        assert!(!is_cache_miss(r#"{"_miss":false}"#));
    }

    /// Slug adayları en fazla `MAX_CDN_SLUG_TRIES` tanesi denenmeli.
    #[test]
    fn test_slug_candidate_tries_are_bounded() {
        assert!(MAX_CDN_SLUG_TRIES <= 2, "her aday bir HTTP isteğidir; sayıyı düşük tut");
    }

    #[test]
    fn test_build_slug_candidates_filters_hashes() {
        let out = build_slug_candidates(
            "Cyberpunk 2077",
            Some("cyberpunk-2077"),
            None,
            Some("a46bfbe055a8429187a30a6ebf0a56ac"),
        );
        assert_eq!(out[0], "cyberpunk-2077");
        assert!(!out.iter().any(|s| s.contains("a46bfbe")));
    }

    /// Gerçek CDN çıktısından türetilmiş örnek: gereksinimler, diller ve medya ayrışmalı.
    #[test]
    fn test_parse_cdn_page_real_shape() {
        let body = serde_json::json!({
            "productRatings": {
                "ratings": [
                    { "title": "PEGI 18", "countryCodes": "TR,GB" }
                ]
            },
            "pages": [
                { "_slug": "home", "data": {
                    "about": {
                        "title": "**CYBERPUNK 2077**",
                        "shortDescription": "An open-world RPG.",
                        "description": "![Gif1](https://x/a.gif)",
                        "image": { "src": "https://x/tall.jpg" }
                    },
                    "hero": {
                        "logoImage": { "src": "https://x/logo.png" },
                        "backgroundImageUrl": "https://x/wide.jpg",
                        "portraitBackgroundImageUrl": "https://x/portrait.jpg"
                    },
                    "carousel": { "items": [
                        { "image": { "src": "https://x/s1.jpg" } },
                        { "video": { "recipes": "{\"en-US\":[{\"recipe\":\"video-fmp4\",\"outputs\":[{\"key\":\"manifest\",\"url\":\"https://x/v.mpd\"},{\"key\":\"thumbnail\",\"url\":\"https://x/v-thumb.png\"}]}]}" } }
                    ]},
                    "requirements": {
                        "languages": ["AUDIO: English, Turkish"],
                        "systems": [{
                            "systemType": "Windows",
                            "details": [
                                { "title": "Memory", "minimum": "12 GB RAM", "recommended": "16 GB RAM" },
                                { "title": "Empty", "minimum": "", "recommended": "" }
                            ]
                        }]
                    },
                    "meta": { "platform": ["Windows", "Mac"], "tags": ["RPG", "SINGLE_PLAYER"] },
                    "socialLinks": { "linkHomepage": "https://cyberpunk.net", "linkTwitter": "" }
                }}
            ]
        });

        let page = parse_cdn_page(&body, "cyberpunk-2077", "TR").expect("parse edilmeli");
        assert_eq!(page.slug, "cyberpunk-2077");
        assert_eq!(page.hero_logo.as_deref(), Some("https://x/logo.png"));
        assert_eq!(page.hero_wide.as_deref(), Some("https://x/wide.jpg"));
        assert_eq!(page.media.len(), 2);
        assert_eq!(page.media[0].kind, "image");
        assert_eq!(page.media[1].kind, "trailer");
        assert_eq!(page.media[1].thumb, "https://x/v-thumb.png");
        assert_eq!(page.requirements.len(), 1);
        // Boş detay satırı elenmeli
        assert_eq!(page.requirements[0].details.len(), 1);
        assert_eq!(page.requirements[0].details[0].title, "Memory");
        assert_eq!(page.languages.len(), 1);
        assert_eq!(page.platforms, vec!["Windows", "Mac"]);
        assert!(page.genres.contains(&"Rpg".to_string()));
        assert!(page.features.contains(&"Tek Oyunculu".to_string()));
        assert_eq!(page.age_rating.as_deref(), Some("PEGI 18"));
        assert_eq!(page.links.len(), 1);
        assert_eq!(page.links[0].label, "Resmi Site");
        // about.description yalnızca görsel içerdiği için long olarak kaydedilmemeli
        assert!(page.about_long.is_none());
    }
}
