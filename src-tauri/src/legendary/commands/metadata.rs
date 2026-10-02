//! HowLongToBeat, critic scores, system requirements, EGL import, third-party launchers.

use super::prelude::*;

/// Derives possible URL slug candidates from the Epic Games Store title and local metadata.
pub fn generate_slug_candidates(
    title: &str,
    folder_name: Option<&str>,
    custom_slug: Option<&str>,
) -> Vec<String> {
    let clean = |s: &str| -> String {
        s.to_lowercase()
            .chars()
            .map(|c| match c {
                'ç' | 'Ç' => 'c',
                'ğ' | 'Ğ' => 'g',
                'ı' | 'İ' => 'i',
                'ö' | 'Ö' => 'o',
                'ş' | 'Ş' => 's',
                'ü' | 'Ü' => 'u',
                // Unicode quotes, apostrophes, dashes, special symbols
                '’' | '‘' | '“' | '”' | '\'' | '"' | '`' | '™' | '®' | '©' | ':' | '!' | '?'
                | '.' | ',' | '-' | '–' | '—' | '_' | '(' | ')' | '[' | ']' | '{' | '}' | '/'
                | '\\' | '|' | '+' | '&' | '\u{00a0}' => ' ',
                _ => c,
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
    };

    let split_camel_or_case = |s: &str| -> String {
        let mut res = String::new();
        let chars: Vec<char> = s.chars().collect();
        for i in 0..chars.len() {
            if i > 0 {
                let prev = chars[i - 1];
                let curr = chars[i];
                let lower_to_upper =
                    prev.is_alphabetic() && prev.is_lowercase() && curr.is_uppercase();
                let letter_to_digit = prev.is_alphabetic() && curr.is_ascii_digit();
                let digit_to_letter = prev.is_ascii_digit() && curr.is_alphabetic();
                if lower_to_upper || letter_to_digit || digit_to_letter {
                    res.push(' ');
                }
            }
            res.push(chars[i]);
        }
        res
    };

    let mut list = Vec::new();
    let mut add = |s: &str| {
        let c = clean(s);
        if c.len() > 1 && !list.contains(&c) {
            list.push(c);
        }
    };

    if let Some(cs) = custom_slug {
        add(cs);
    }

    add(title);

    if let Some(fn_str) = folder_name {
        add(fn_str);
        add(&split_camel_or_case(fn_str));
    }

    // 1. Strip the colon (subtitle) and dashes: "The Dungeon of Naheulbeuk: The Amulet of Chaos" -> "the-dungeon-of-naheulbeuk"
    if let Some(pos) = title.find(':') {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" - ") {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" – ") {
        add(&title[..pos]);
    }

    // 2. Produce an alternative by stripping known publisher and series prefixes
    let lower = title.to_lowercase();
    let prefixes = [
        "tom clancy's ",
        "tom clancy’s ",
        "tom clancys ",
        "sid meier's ",
        "sid meier’s ",
        "sid meiers ",
        "marvel's ",
        "marvel’s ",
        "marvels ",
        "disney's ",
        "disney’s ",
        "disneys ",
        "disney ",
        "warhammer 40,000: ",
        "warhammer 40000: ",
        "warhammer: ",
        "warhammer ",
        "ea sports ",
        "star wars: ",
        "star wars™: ",
        "star wars™ ",
        "star wars ",
        "the lord of the rings: ",
        "the lord of the rings ",
        "lego® ",
        "lego ",
        "a game of thrones: ",
        "grand theft auto: ",
    ];

    for p in prefixes {
        if lower.starts_with(p) {
            let rest = &title[p.len()..];
            add(rest);
            if let Some(pos) = rest.find(':') {
                add(&rest[..pos]);
            }
        }
    }

    // 3. Produce an alternative by stripping known edition suffixes
    let suffixes = [
        "standard edition",
        "definitive edition",
        "enhanced edition",
        "deluxe edition",
        "special edition",
        "complete edition",
        "complete journey",
        "game of the year edition",
        "game of the year",
        "goty edition",
        "goty",
        "anniversary edition",
        "zen edition",
        "pre-game editor",
        "editor",
        "digital edition",
        "next stop",
    ];

    for suffix in suffixes {
        if let Some(pos) = lower.find(suffix) {
            let prefix = &title[..pos]
                .trim()
                .trim_end_matches(&['-', ':', '–', '—'][..]);
            add(prefix);
        }
    }

    list
}

/// Fetches and returns HowLongToBeat data.
#[tauri::command]
pub async fn epic_get_hltb(
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<crate::legendary::hltb::HltbData, String> {
    let force = force_refresh.unwrap_or(false);
    Ok(crate::legendary::hltb::get_hltb_data(&title, &app_name, force).await)
}

/// Fetches and returns critic and review data (OpenCritic, Metacritic, IGDB).
#[tauri::command]
pub async fn epic_get_critic(
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<crate::legendary::critic::CriticData, String> {
    let force = force_refresh.unwrap_or(false);
    Ok(crate::legendary::critic::get_critic_data(&title, &app_name, force).await)
}

/// Fetches system requirements from the Epic Games Store content API and caches them to disk.
#[tauri::command]
pub async fn epic_get_system_requirements(
    _app: AppHandle,
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<GameRequirementsResponse, String> {
    let config_dir = skip::default_config_dir();
    let specs_dir = config_dir.join("specs");
    let cache_file = specs_dir.join(format!("{}.json", app_name));
    let force = force_refresh.unwrap_or(false);

    // 1. Check the disk cache first (only supported, fresh entries with the new schema)
    if !force && cache_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(cached) = serde_json::from_str::<GameRequirementsResponse>(&content) {
                if cached.supported && content.contains("\"short_description\"") {
                    return Ok(cached);
                }
            }
        }
    }

    // 2. Scan FolderName and custom slug from the local metadata file
    let meta_file = config_dir
        .join("metadata")
        .join(format!("{}.json", app_name));
    let mut folder_name: Option<String> = None;
    let mut custom_slug: Option<String> = None;

    if meta_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&meta_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let meta = v.get("metadata").unwrap_or(&v);
                if let Some(cattr) = meta.get("customAttributes") {
                    if let Some(fn_val) = cattr
                        .get("FolderName")
                        .and_then(|x| x.get("value"))
                        .and_then(|x| x.as_str())
                    {
                        folder_name = Some(fn_val.to_string());
                    }
                    if let Some(ps_val) = cattr
                        .get("com.epicgames.app.productSlug")
                        .and_then(|x| x.get("value"))
                        .and_then(|x| x.as_str())
                    {
                        custom_slug = Some(ps_val.to_string());
                    }
                }
                if custom_slug.is_none() {
                    if let Some(ps) = meta.get("productSlug").and_then(|x| x.as_str()) {
                        custom_slug = Some(ps.to_string());
                    } else if let Some(us) = meta.get("urlSlug").and_then(|x| x.as_str()) {
                        custom_slug = Some(us.to_string());
                    }
                }
            }
        }
    }

    // 3. Prepare slug candidates
    let slugs = generate_slug_candidates(&title, folder_name.as_deref(), custom_slug.as_deref());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let locales = ["tr-TR", "en-US"];

    for slug in &slugs {
        for locale in &locales {
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
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };

            let text = match resp.text().await {
                Ok(t) => t,
                Err(_) => continue,
            };

            if let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(pages) = body.get("pages").and_then(|p| p.as_array()) {
                    for page in pages {
                        let page_data = page.get("data");
                        let reqs = page_data.and_then(|d| d.get("requirements"));

                        let mut store_desc: Option<String> = None;
                        let mut store_short_desc: Option<String> = None;
                        let mut store_tags: Vec<String> = Vec::new();

                        if let Some(about) = page_data.and_then(|d| d.get("about")) {
                            if let Some(sd) = about.get("shortDescription").and_then(|s| s.as_str())
                            {
                                if !sd.trim().is_empty() {
                                    store_short_desc = Some(sd.trim().to_string());
                                }
                            }
                            if let Some(desc) = about.get("description").and_then(|s| s.as_str()) {
                                if !desc.trim().is_empty() {
                                    store_desc = Some(desc.trim().to_string());
                                }
                            }
                        }

                        if let Some(tags_arr) = page_data
                            .and_then(|d| d.get("meta"))
                            .and_then(|m| m.get("tags"))
                            .and_then(|t| t.as_array())
                        {
                            store_tags = tags_arr
                                .iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect();
                        }

                        let languages = reqs
                            .and_then(|r| r.get("languages"))
                            .and_then(|l| l.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let mut systems = Vec::new();
                        if let Some(sys_arr) = reqs
                            .and_then(|r| r.get("systems"))
                            .and_then(|s| s.as_array())
                        {
                            for sys_val in sys_arr {
                                let sys_type = sys_val
                                    .get("systemType")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("Windows")
                                    .to_string();

                                let mut details = Vec::new();
                                if let Some(det_arr) =
                                    sys_val.get("details").and_then(|d| d.as_array())
                                {
                                    for det in det_arr {
                                        let det_title = det
                                            .get("title")
                                            .and_then(|t| t.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        if det_title.is_empty() {
                                            continue;
                                        }
                                        let minimum = det
                                            .get("minimum")
                                            .and_then(|m| m.as_str())
                                            .map(|s| s.to_string());
                                        let recommended = det
                                            .get("recommended")
                                            .and_then(|r| r.as_str())
                                            .map(|s| s.to_string());
                                        details.push(SystemDetailItem {
                                            title: det_title,
                                            minimum,
                                            recommended,
                                        });
                                    }
                                }

                                if !details.is_empty() {
                                    systems.push(SystemRequirement {
                                        system_type: sys_type,
                                        details,
                                    });
                                }
                            }
                        }

                        if !systems.is_empty() || store_short_desc.is_some() || store_desc.is_some()
                        {
                            let result = GameRequirementsResponse {
                                supported: true,
                                systems,
                                languages,
                                app_name: app_name.clone(),
                                description: store_desc,
                                short_description: store_short_desc,
                                tags: store_tags,
                            };

                            let _ = std::fs::create_dir_all(&specs_dir);
                            if let Ok(json_str) = serde_json::to_string(&result) {
                                let _ = std::fs::write(&cache_file, json_str);
                            }

                            return Ok(result);
                        }
                    }
                }
            }
        }
    }

    // If not found, return supported: false gracefully (do not lock failures to disk permanently)
    let fallback = GameRequirementsResponse {
        supported: false,
        systems: vec![],
        languages: vec![],
        app_name: app_name.clone(),
        description: None,
        short_description: None,
        tags: vec![],
    };

    Ok(fallback)
}

/// Detects games installed through the Epic Games Launcher.
#[tauri::command]
pub async fn epic_detect_egl_games(_app: AppHandle) -> Result<Vec<cache::EglDetectedGame>, String> {
    // Reads EGL manifests + registry: keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(cache::read_egl_installed_games)
        .await
        .map_err(|e| e.to_string())
}

/// Persistently syncs games detected in the Epic Games Launcher into installed.json.
#[tauri::command]
pub async fn epic_sync_egl_installed(_app: AppHandle) -> Result<u32, String> {
    let config = skip::default_config_dir();
    let installed_path = config.join("installed.json");
    let mut map: std::collections::HashMap<String, InstalledGame> =
        match std::fs::read_to_string(&installed_path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => std::collections::HashMap::new(),
        };

    let egl_games = cache::read_egl_installed_games();
    let mut imported_count = 0;

    for egl in egl_games {
        if !map.contains_key(&egl.app_name) {
            map.insert(
                egl.app_name.clone(),
                InstalledGame {
                    app_name: egl.app_name,
                    title: egl.title,
                    version: egl.version,
                    install_path: egl.install_path,
                    install_size: egl.install_size,
                    executable: egl.executable,
                    can_run_offline: true,
                    egl_guid: String::new(),
                    launch_parameters: String::new(),
                    manifest_path: String::new(),
                    needs_verification: false,
                    platform: "Windows".to_string(),
                    prereq_info: None,
                    uninstaller: None,
                    requires_ot: false,
                    save_path: None,
                    is_preloaded: false,
                    is_dlc: false,
                    base_urls: vec![],
                    install_tags: vec![],
                },
            );
            imported_count += 1;
        }
    }

    if imported_count > 0 {
        let json_str = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
        std::fs::write(&installed_path, json_str).map_err(|e| e.to_string())?;
    }

    Ok(imported_count)
}

/* ---------- Game management & verification ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_generate_slug_candidates() {
        let slugs1 = generate_slug_candidates("Absolute Drift: Zen Edition", None, None);
        assert!(slugs1.contains(&"absolute-drift-zen-edition".to_string()));
        assert!(slugs1.contains(&"absolute-drift".to_string()));

        let slugs2 =
            generate_slug_candidates("art of rally Standard Edition", Some("artofrally"), None);
        assert!(slugs2.contains(&"art-of-rally-standard-edition".to_string()));
        assert!(slugs2.contains(&"art-of-rally".to_string()));

        let slugs3 = generate_slug_candidates("Mortal Shell™", Some("MortalShell"), None);
        assert_eq!(slugs3[0], "mortal-shell");

        let slugs4 = generate_slug_candidates(
            "Tom Clancy’s Rainbow Six Siege",
            Some("RainbowSixSiege"),
            None,
        );
        assert!(
            slugs4.contains(&"rainbow-six-siege".to_string()),
            "Rainbow Six Siege slug candidates must include 'rainbow-six-siege'"
        );

        let slugs5 = generate_slug_candidates(
            "The Dungeon Of Naheulbeuk: The Amulet Of Chaos",
            Some("DungeonOfNaheulbeuk"),
            None,
        );
        assert!(slugs5.contains(&"the-dungeon-of-naheulbeuk".to_string()));
    }
}
