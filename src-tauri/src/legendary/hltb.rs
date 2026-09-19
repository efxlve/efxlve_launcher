use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HltbData {
    pub app_name: String,
    pub title: String,
    pub supported: bool,
    pub main_story: Option<f64>,
    pub main_extra: Option<f64>,
    pub completionist: Option<f64>,
}

/// Arama terimini HLTB için optimize eder (edisyon ve yayıncı takılarını temizler).
pub fn clean_hltb_search_term(title: &str) -> String {
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
        if sub.to_lowercase().contains("edition")
            || sub.to_lowercase().contains("cut")
            || sub.to_lowercase().contains("version")
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
        " Remastered",
    ];
    for suffix in edition_suffixes {
        if let Some(pos) = s.to_lowercase().find(&suffix.to_lowercase()) {
            s = s[..pos].to_string();
        }
    }

    s.trim().to_string()
}

fn hltb_cache_dir() -> PathBuf {
    if let Some(config_dir) = dirs_config_dir() {
        config_dir.join("legendary").join("hltb")
    } else {
        PathBuf::from("hltb_cache")
    }
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
}

pub async fn get_hltb_data(title: &str, app_name: &str, force_refresh: bool) -> HltbData {
    let clean_app = app_name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], "_");
    let cache_file = hltb_cache_dir().join(format!("{}.json", clean_app));

    if !force_refresh && cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(data) = serde_json::from_str::<HltbData>(&content) {
                if data.supported {
                    return data;
                }
            }
        }
    }

    let search_term = clean_hltb_search_term(title);
    let terms: Vec<&str> = search_term.split_whitespace().collect();
    if terms.is_empty() {
        return HltbData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported: false,
            main_story: None,
            main_extra: None,
            completionist: None,
        };
    }

    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return HltbData {
                app_name: app_name.to_string(),
                title: title.to_string(),
                supported: false,
                main_story: None,
                main_extra: None,
                completionist: None,
            };
        }
    };

    // 1. Arama endpoint'ini dinamik tespit et (varsayılan: /api/search/site)
    let mut search_endpoint = "/api/search/site".to_string();
    if let Ok(home_resp) = client
        .get("https://howlongtobeat.com/")
        .header("User-Agent", ua)
        .send()
        .await
    {
        if let Ok(home_html) = home_resp.text().await {
            for part in home_html.split("src=\"") {
                if let Some(end) = part.find('\"') {
                    let path = &part[..end];
                    if path.contains("/_next/static/chunks/") {
                        let script_url = format!("https://howlongtobeat.com{}", path);
                        if let Ok(s_resp) = client.get(&script_url).header("User-Agent", ua).send().await {
                            if let Ok(js_content) = s_resp.text().await {
                                if let Some(idx) = js_content.find("/api/search/") {
                                    let sub = &js_content[idx..];
                                    if let Some(end_quote) = sub.find(['\"', '\'', '`', '?', ' ', '$']) {
                                        let mut ep = sub[..end_quote].trim_end_matches('/').to_string();
                                        if let Some(pos) = ep.find("/init") {
                                            ep = ep[..pos].to_string();
                                        }
                                        let ep = ep.trim_end_matches('/').to_string();
                                        if !ep.is_empty() {
                                            search_endpoint = ep;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Auth token & dynamic key/val al
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let init_url = format!("https://howlongtobeat.com{}/init?t={}", search_endpoint, now);

    let mut auth_token = String::new();
    let mut auth_key = String::new();
    let mut auth_val = String::new();

    if let Ok(init_resp) = client
        .get(&init_url)
        .header("User-Agent", ua)
        .header("Referer", "https://howlongtobeat.com/")
        .send()
        .await
    {
        if let Ok(init_json) = init_resp.json::<serde_json::Value>().await {
            if let Some(t) = init_json.get("token").and_then(|x| x.as_str()) {
                auth_token = t.to_string();
            }
            if let Some(obj) = init_json.as_object() {
                for (k, v) in obj {
                    let lower = k.to_lowercase();
                    if lower.contains("key") {
                        if let Some(s) = v.as_str() {
                            auth_key = s.to_string();
                        }
                    } else if lower.contains("val") {
                        if let Some(s) = v.as_str() {
                            auth_val = s.to_string();
                        }
                    }
                }
            }
        }
    }

    // 3. Arama isteğini hazırla
    let mut payload = serde_json::json!({
        "searchType": "games",
        "searchTerms": terms,
        "searchPage": 1,
        "size": 20,
        "searchOptions": {
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": { "min": 0, "max": 0 },
                "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
                "rangeYear": { "min": "", "max": "" },
                "modifier": ""
            },
            "users": { "sortCategory": "postcount" },
            "lists": { "sortCategory": "follows" },
            "filter": "",
            "sort": 0,
            "randomizer": 0
        },
        "useCache": true
    });

    if !auth_key.is_empty() && !auth_val.is_empty() {
        if let Some(m) = payload.as_object_mut() {
            m.insert(auth_key.clone(), serde_json::Value::String(auth_val.clone()));
        }
    }

    let search_url = format!("https://howlongtobeat.com{}", search_endpoint);
    let mut req = client
        .post(&search_url)
        .header("User-Agent", ua)
        .header("Referer", "https://howlongtobeat.com/")
        .header("Origin", "https://howlongtobeat.com")
        .header("Content-Type", "application/json")
        .header("Accept", "*/*");

    if !auth_token.is_empty() {
        req = req.header("x-auth-token", &auth_token);
    }
    if !auth_key.is_empty() {
        req = req.header("x-hp-key", &auth_key);
    }
    if !auth_val.is_empty() {
        req = req.header("x-hp-val", &auth_val);
    }

    let resp = req.json(&payload).send().await;

    let result_data = match resp {
        Ok(r) if r.status().is_success() => {
            if let Ok(text) = r.text().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    parse_hltb_response(app_name, title, &val)
                } else {
                    HltbData {
                        app_name: app_name.to_string(),
                        title: title.to_string(),
                        supported: false,
                        main_story: None,
                        main_extra: None,
                        completionist: None,
                    }
                }
            } else {
                HltbData {
                    app_name: app_name.to_string(),
                    title: title.to_string(),
                    supported: false,
                    main_story: None,
                    main_extra: None,
                    completionist: None,
                }
            }
        }
        _ => HltbData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported: false,
            main_story: None,
            main_extra: None,
            completionist: None,
        },
    };

    // Sadece geçerli süre verisi içeren sonuçları önbelleğe kaydet
    if result_data.supported {
        if let Ok(_) = tokio::fs::create_dir_all(hltb_cache_dir()).await {
            if let Ok(json_str) = serde_json::to_string_pretty(&result_data) {
                let _ = tokio::fs::write(&cache_file, json_str).await;
            }
        }
    }

    result_data
}

fn parse_hltb_response(app_name: &str, title: &str, val: &serde_json::Value) -> HltbData {
    if let Some(items) = val.get("data").and_then(|d| d.as_array()) {
        if let Some(first) = items.first() {
            let sec_to_hours = |k: &str| -> Option<f64> {
                let s = first.get(k)?.as_f64()?;
                if s <= 0.0 {
                    None
                } else {
                    Some(((s / 3600.0) * 10.0).round() / 10.0)
                }
            };

            let main_story = sec_to_hours("comp_main");
            let main_extra = sec_to_hours("comp_plus");
            let completionist = sec_to_hours("comp_100");

            let supported = main_story.is_some() || main_extra.is_some() || completionist.is_some();

            return HltbData {
                app_name: app_name.to_string(),
                title: title.to_string(),
                supported,
                main_story,
                main_extra,
                completionist,
            };
        }
    }

    HltbData {
        app_name: app_name.to_string(),
        title: title.to_string(),
        supported: false,
        main_story: None,
        main_extra: None,
        completionist: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_hltb_search_term() {
        assert_eq!(
            clean_hltb_search_term("Cyberpunk 2077 - Standard Edition"),
            "Cyberpunk 2077"
        );
        assert_eq!(
            clean_hltb_search_term("Tom Clancy's Rainbow Six Siege"),
            "Rainbow Six Siege"
        );
        assert_eq!(
            clean_hltb_search_term("Marvel's Spider-Man Remastered"),
            "Spider-Man"
        );
        assert_eq!(
            clean_hltb_search_term("The Witcher 3: Wild Hunt - Game of the Year Edition"),
            "The Witcher 3: Wild Hunt"
        );
    }

    #[test]
    fn test_parse_hltb_response() {
        let json = serde_json::json!({
            "data": [{
                "game_id": 2127,
                "game_name": "Cyberpunk 2077",
                "comp_main": 90000,
                "comp_plus": 216000,
                "comp_100": 360000
            }]
        });

        let data = parse_hltb_response("Ginger", "Cyberpunk 2077", &json);
        assert!(data.supported);
        assert_eq!(data.main_story, Some(25.0));
        assert_eq!(data.main_extra, Some(60.0));
        assert_eq!(data.completionist, Some(100.0));
    }
}
