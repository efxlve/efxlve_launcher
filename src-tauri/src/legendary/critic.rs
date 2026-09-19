use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticData {
    pub app_name: String,
    pub title: String,
    pub supported: bool,
    pub opencritic_score: Option<u32>,
    pub opencritic_url: Option<String>,
    pub metacritic_score: Option<u32>,
    pub metacritic_url: Option<String>,
    pub igdb_score: Option<f64>,
    pub tier: Option<String>,
}

/// Arama terimini PCGamingWiki & eleştirmen aramaları için optimize eder.
pub fn clean_critic_search_term(title: &str) -> String {
    let mut s = title
        .replace(['\u{2018}', '\u{2019}', '\u{00B4}', '`'], "'")
        .replace(['™', '®', '\u{00A0}'], " ");

    // Yaygın seri / yayıncı ön ekleri
    let prefixes = [
        "Tom Clancy's ",
        "Marvel's ",
        "Sid Meier's ",
        "Disney's ",
        "EA SPORTS ",
        "Star Wars ",
        "STAR WARS ",
        "Warhammer 40,000: ",
        "Warhammer: ",
    ];
    for p in prefixes {
        if s.starts_with(p) {
            s = s[p.len()..].to_string();
        }
    }

    // İki nokta veya tire sonrası edisyonları temizle
    if let Some(pos) = s.find(" - ") {
        let sub = &s[pos + 3..];
        let sub_low = sub.to_lowercase();
        if sub_low.contains("edition")
            || sub_low.contains("cut")
            || sub_low.contains("version")
            || sub_low.contains("remastered")
        {
            s = s[..pos].to_string();
        }
    }

    // Yaygın sürüm ekleri
    let edition_suffixes = [
        " Standard Edition",
        " Enhanced Edition",
        " Definitive Edition",
        " Gold Edition",
        " Deluxe Edition",
        " Complete Edition",
        " Game of the Year Edition",
        " GOTY Edition",
        " Special Edition",
        " Director's Cut",
        " Remastered",
    ];
    for suffix in edition_suffixes {
        if let Some(pos) = s.to_lowercase().find(&suffix.to_lowercase()) {
            s = s[..pos].to_string();
        }
    }

    s.trim().to_string()
}

fn critic_cache_dir() -> PathBuf {
    if let Some(config_dir) = dirs_config_dir() {
        config_dir.join("legendary").join("critic")
    } else {
        PathBuf::from("critic_cache")
    }
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
}

pub fn calculate_tier(score: u32) -> &'static str {
    if score >= 84 {
        "Mighty"
    } else if score >= 75 {
        "Strong"
    } else if score >= 66 {
        "Fair"
    } else {
        "Weak"
    }
}

/// PCGamingWiki MediaWiki içerik metnindeki `{{Infobox game/row/reception|...}}` satırlarını ayrıştırır.
pub fn parse_reception_data(content: &str) -> (Option<u32>, Option<String>, Option<u32>, Option<String>, Option<f64>) {
    let mut oc_score: Option<u32> = None;
    let mut oc_url: Option<String> = None;
    let mut mc_score: Option<u32> = None;
    let mut mc_url: Option<String> = None;
    let mut igdb_score: Option<f64> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        let lower = line.to_lowercase();
        if !lower.contains("infobox game/row/reception") {
            continue;
        }

        // Örnek: {{Infobox game/row/reception|Opencritic|2844/dead-by-daylight|70}}
        // Örnek: {{Infobox game/row/reception|Metacritic|dead-by-daylight|71}}
        if let Some(start) = line.find("{{") {
            let inner = &line[start + 2..];
            let inner = if let Some(end) = inner.find("}}") {
                &inner[..end]
            } else {
                inner
            };

            let parts: Vec<&str> = inner.split('|').map(|p| p.trim()).collect();
            if parts.len() >= 4 {
                let provider = parts[1].to_lowercase();
                let id_or_slug = parts[2];
                let score_str = parts[3];

                if provider.contains("opencritic") {
                    if let Ok(s) = score_str.parse::<u32>() {
                        oc_score = Some(s);
                        if !id_or_slug.is_empty() {
                            oc_url = Some(if id_or_slug.starts_with("http") {
                                id_or_slug.to_string()
                            } else {
                                format!("https://opencritic.com/game/{}", id_or_slug)
                            });
                        }
                    }
                } else if provider.contains("metacritic") {
                    if let Ok(s) = score_str.parse::<u32>() {
                        mc_score = Some(s);
                        if !id_or_slug.is_empty() {
                            mc_url = Some(if id_or_slug.starts_with("http") {
                                id_or_slug.to_string()
                            } else {
                                format!("https://www.metacritic.com/game/{}/", id_or_slug.trim_end_matches('/'))
                            });
                        }
                    }
                } else if provider.contains("igdb") {
                    if let Ok(s) = score_str.parse::<f64>() {
                        igdb_score = Some(s);
                    }
                }
            }
        }
    }

    (oc_score, oc_url, mc_score, mc_url, igdb_score)
}

pub async fn get_critic_data(title: &str, app_name: &str, force_refresh: bool) -> CriticData {
    let clean_app = app_name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], "_");
    let cache_dir = critic_cache_dir();
    let cache_file = cache_dir.join(format!("{}.json", clean_app));

    // 1. Önbellek kontrolü
    if !force_refresh && cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(data) = serde_json::from_str::<CriticData>(&content) {
                if data.supported {
                    return data;
                }
            }
        }
    }

    let search_term = clean_critic_search_term(title);
    if search_term.is_empty() {
        return CriticData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported: false,
            opencritic_score: None,
            opencritic_url: None,
            metacritic_score: None,
            metacritic_url: None,
            igdb_score: None,
            tier: None,
        };
    }

    let ua = "EfxlveLauncher/1.0 (https://github.com/efxlve/launcher)";
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return CriticData {
                app_name: app_name.to_string(),
                title: title.to_string(),
                supported: false,
                opencritic_score: None,
                opencritic_url: None,
                metacritic_score: None,
                metacritic_url: None,
                igdb_score: None,
                tier: None,
            };
        }
    };

    // 2. PCGamingWiki opensearch ile sayfa başlığını doğrula
    let mut target_page = search_term.clone();
    let search_url = format!(
        "https://www.pcgamingwiki.com/w/api.php?action=opensearch&search={}&limit=1&format=json",
        url::form_urlencoded::byte_serialize(search_term.as_bytes()).collect::<String>()
    );

    if let Ok(resp) = client.get(&search_url).header("User-Agent", ua).send().await {
        if let Ok(json_val) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = json_val.get(1).and_then(|v| v.as_array()) {
                if let Some(first) = arr.first().and_then(|v| v.as_str()) {
                    if !first.trim().is_empty() {
                        target_page = first.to_string();
                    }
                }
            }
        }
    }

    // 3. PCGamingWiki sayfa revizyon içeriğini sorgula
    let query_url = format!(
        "https://www.pcgamingwiki.com/w/api.php?action=query&titles={}&prop=revisions&rvprop=content&format=json&redirects=1",
        url::form_urlencoded::byte_serialize(target_page.as_bytes()).collect::<String>()
    );

    let mut oc_score: Option<u32> = None;
    let mut oc_url: Option<String> = None;
    let mut mc_score: Option<u32> = None;
    let mut mc_url: Option<String> = None;
    let mut igdb_score: Option<f64> = None;

    if let Ok(resp) = client.get(&query_url).header("User-Agent", ua).send().await {
        if let Ok(json_val) = resp.json::<serde_json::Value>().await {
            if let Some(pages) = json_val.get("query").and_then(|q| q.get("pages")).and_then(|p| p.as_object()) {
                for (_pid, pdata) in pages {
                    if let Some(revs) = pdata.get("revisions").and_then(|r| r.as_array()) {
                        if let Some(first_rev) = revs.first() {
                            if let Some(content_str) = first_rev.get("*").and_then(|c| c.as_str()) {
                                let (o_sc, o_u, m_sc, m_u, i_sc) = parse_reception_data(content_str);
                                oc_score = o_sc;
                                oc_url = o_u;
                                mc_score = m_sc;
                                mc_url = m_u;
                                igdb_score = i_sc;
                            }
                        }
                    }
                }
            }
        }
    }

    let supported = oc_score.is_some() || mc_score.is_some() || igdb_score.is_some();
    let effective_score = oc_score.or(mc_score);
    let tier = effective_score.map(|s| calculate_tier(s).to_string());

    let result = CriticData {
        app_name: app_name.to_string(),
        title: title.to_string(),
        supported,
        opencritic_score: oc_score,
        opencritic_url: oc_url,
        metacritic_score: mc_score,
        metacritic_url: mc_url,
        igdb_score,
        tier,
    };

    // 4. Diske kaydet
    if supported {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(json_str) = serde_json::to_string_pretty(&result) {
            let _ = tokio::fs::write(&cache_file, json_str).await;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_critic_search_term() {
        assert_eq!(clean_critic_search_term("Dead by Daylight - Gold Edition"), "Dead by Daylight");
        assert_eq!(clean_critic_search_term("Alan Wake 2 Deluxe Edition"), "Alan Wake 2");
        assert_eq!(clean_critic_search_term("Tom Clancy's The Division 2"), "The Division 2");
        assert_eq!(clean_critic_search_term("Death Stranding Director's Cut"), "Death Stranding");
    }

    #[test]
    fn test_calculate_tier() {
        assert_eq!(calculate_tier(94), "Mighty");
        assert_eq!(calculate_tier(84), "Mighty");
        assert_eq!(calculate_tier(80), "Strong");
        assert_eq!(calculate_tier(75), "Strong");
        assert_eq!(calculate_tier(70), "Fair");
        assert_eq!(calculate_tier(66), "Fair");
        assert_eq!(calculate_tier(60), "Weak");
    }

    #[test]
    fn test_parse_reception_data() {
        let sample = r#"
|reception    =
{{Infobox game/row/reception|Metacritic|dead-by-daylight|71}}
{{Infobox game/row/reception|Opencritic|2844/dead-by-daylight|70}}
{{Infobox game/row/reception|IGDB|dead-by-daylight|6.7}}
        "#;
        let (oc_score, oc_url, mc_score, mc_url, igdb_score) = parse_reception_data(sample);
        assert_eq!(oc_score, Some(70));
        assert_eq!(oc_url, Some("https://opencritic.com/game/2844/dead-by-daylight".to_string()));
        assert_eq!(mc_score, Some(71));
        assert_eq!(mc_url, Some("https://www.metacritic.com/game/dead-by-daylight/".to_string()));
        assert_eq!(igdb_score, Some(6.7));
    }
}
