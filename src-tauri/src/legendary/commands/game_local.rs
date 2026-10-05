//! Per-game settings, cloud sync, desktop shortcuts, DLC, and install options.

use super::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLocalSettings {
    pub app_name: String,
    pub title: String,
    pub launch_parameters: String,
    pub auto_update: bool,
    pub high_priority: bool,
    pub cloud_saves_enabled: bool,
    pub last_cloud_sync: Option<String>,
    pub install_size: u64,
    pub install_path: String,
    pub version: String,
    /// Optional wrapper command passed to `legendary launch --wrapper`.
    #[serde(default)]
    pub wrapper: String,
    /// Extra environment variables exported to the game process.
    #[serde(default)]
    pub env_vars: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub custom_save_path: Option<String>,
    #[serde(default)]
    pub detected_save_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCustomConfig {
    pub auto_update: Option<bool>,
    pub high_priority: Option<bool>,
    pub cloud_saves_enabled: Option<bool>,
    pub last_cloud_sync: Option<String>,
    pub wrapper: Option<String>,
    pub env_vars: Option<std::collections::HashMap<String, String>>,
    pub custom_save_path: Option<String>,
    /// Extra launch arguments, for stores whose launch command takes them
    /// (Epic keeps its own copy in installed.json).
    #[serde(default)]
    pub launch_parameters: Option<String>,
}

pub fn load_all_game_custom_configs() -> std::collections::HashMap<String, GameCustomConfig> {
    let config = skip::default_config_dir();
    let p = config.join("efxlve_game_settings.json");
    if let Ok(text) = std::fs::read_to_string(&p) {
        serde_json::from_str(&text).unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    }
}

fn save_all_game_custom_configs(map: &std::collections::HashMap<String, GameCustomConfig>) {
    let config = skip::default_config_dir();
    let p = config.join("efxlve_game_settings.json");
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(p, json);
    }
}

pub fn update_game_last_cloud_sync(app_name: &str, timestamp: &str) {
    let mut map = load_all_game_custom_configs();
    let mut entry = map.remove(app_name).unwrap_or_default();
    entry.last_cloud_sync = Some(timestamp.to_string());
    map.insert(app_name.to_string(), entry);
    save_all_game_custom_configs(&map);
}

#[tauri::command]
pub fn epic_get_game_settings(app_name: String) -> Result<GameLocalSettings, String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    // Fast path: direct read of installed.json (instant, 0ms)
    let mut entry: Option<InstalledGame> = None;
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
        {
            entry = map.get(&app_name).cloned();
        }
    }

    if entry.is_none() {
        for egl in cache::read_egl_installed_games() {
            if egl.app_name == app_name {
                entry = Some(InstalledGame {
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
                });
                break;
            }
        }
    }

    let cfgs = load_all_game_custom_configs();
    let cfg = cfgs.get(&app_name);

    Ok(GameLocalSettings {
        app_name: app_name.clone(),
        title: entry
            .as_ref()
            .map(|e| e.title.clone())
            .unwrap_or_else(|| app_name.clone()),
        launch_parameters: entry
            .as_ref()
            .map(|e| e.launch_parameters.clone())
            .unwrap_or_default(),
        auto_update: cfg.and_then(|c| c.auto_update).unwrap_or(true),
        high_priority: cfg.and_then(|c| c.high_priority).unwrap_or(false),
        cloud_saves_enabled: cfg.and_then(|c| c.cloud_saves_enabled).unwrap_or(true),
        last_cloud_sync: cfg.and_then(|c| c.last_cloud_sync.clone()),
        install_size: entry.as_ref().map(|e| e.install_size).unwrap_or(0),
        install_path: entry
            .as_ref()
            .map(|e| e.install_path.clone())
            .unwrap_or_default(),
        version: entry
            .as_ref()
            .map(|e| e.version.clone())
            .unwrap_or_default(),
        wrapper: cfg.and_then(|c| c.wrapper.clone()).unwrap_or_default(),
        env_vars: cfg.and_then(|c| c.env_vars.clone()).unwrap_or_default(),
        save_path: entry.as_ref().and_then(|e| e.save_path.clone()),
        custom_save_path: cfg.and_then(|c| c.custom_save_path.clone()),
        detected_save_path: {
            let title = entry.as_ref().map(|e| e.title.as_str());
            let ip = entry.as_ref().map(|e| e.install_path.as_str());
            crate::legendary::backup::detect_save_path(&app_name, title, ip)
        },
    })
}

#[tauri::command]
pub fn epic_save_game_settings(settings: GameLocalSettings) -> Result<(), String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    // 1. Update launch_parameters in installed.json
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(mut map) =
            serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
        {
            if let Some(entry) = map.get_mut(&settings.app_name) {
                entry.launch_parameters = settings.launch_parameters.trim().to_string();
                if let Ok(out) = serde_json::to_string_pretty(&map) {
                    let _ = std::fs::write(&installed_file, out);
                }
            }
        }
    }

    // 2. Update the settings in efxlve_game_settings.json
    let mut cfgs = load_all_game_custom_configs();
    cfgs.insert(
        settings.app_name,
        GameCustomConfig {
            auto_update: Some(settings.auto_update),
            high_priority: Some(settings.high_priority),
            cloud_saves_enabled: Some(settings.cloud_saves_enabled),
            last_cloud_sync: settings.last_cloud_sync,
            wrapper: Some(settings.wrapper.trim().to_string()),
            env_vars: Some(settings.env_vars),
            custom_save_path: settings.custom_save_path,
            launch_parameters: Some(settings.launch_parameters.trim().to_string()),
        },
    );
    save_all_game_custom_configs(&cfgs);
    Ok(())
}

/// Sets or clears the custom save directory for a specific game.
#[tauri::command]
pub fn epic_set_custom_save_path(
    app_name: String,
    save_path: Option<String>,
) -> Result<(), String> {
    let mut cfgs = load_all_game_custom_configs();
    let entry = cfgs.entry(app_name).or_default();
    entry.custom_save_path = save_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    save_all_game_custom_configs(&cfgs);
    Ok(())
}

#[tauri::command]
pub async fn epic_sync_saves(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["-y", "sync-saves", &app_name]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}\n{stderr}");

    if out.status.success() {
        // Record the last sync time
        let now = {
            let local_now = std::time::SystemTime::now();
            let since_epoch = local_now
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let rem_secs = since_epoch % 86400;
            let hours = (rem_secs / 3600) + 3; // TR UTC+3
            let minutes = (rem_secs % 3600) / 60;
            format!("@t:manage.todayAt\u{1f}{:02}:{:02}", hours % 24, minutes)
        };
        update_game_last_cloud_sync(&app_name, &now);

        Ok("@t:manage.cloudSyncedOk".to_string())
    } else {
        Err(transient_reason(&combined).unwrap_or(&combined).to_string())
    }
}

/// Desktop `.lnk` name. Must match what `epic_create_desktop_shortcut` writes.
pub(crate) fn desktop_shortcut_file_name(title: &str) -> String {
    let clean = title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], " ");
    format!("{}.lnk", clean.trim())
}

fn installed_title(app_name: &str) -> Option<String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
        {
            if let Some(entry) = map.get(app_name) {
                if !entry.title.trim().is_empty() {
                    return Some(entry.title.clone());
                }
            }
        }
    }
    cache::read_installed(&config)
        .into_iter()
        .find(|g| g.app_name == app_name)
        .map(|g| g.title)
        .filter(|t| !t.trim().is_empty())
}

/// Removes the desktop shortcut this launcher created. Missing files are ignored.
pub async fn remove_desktop_shortcut(app_name: &str) {
    #[cfg(windows)]
    {
        let Some(title) = installed_title(app_name) else {
            return;
        };
        let file_name = desktop_shortcut_file_name(&title).replace('\'', "''");
        if file_name == ".lnk" {
            return;
        }
        let ps = format!(
            "$d = [Environment]::GetFolderPath('Desktop'); $lnk = Join-Path $d '{file_name}'; if (Test-Path -LiteralPath $lnk) {{ Remove-Item -LiteralPath $lnk -Force }}"
        );
        let _ = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(0x08000000)
            .output()
            .await;
    }
}

#[tauri::command]
pub async fn epic_create_desktop_shortcut(
    _app: AppHandle,
    app_name: String,
) -> Result<String, String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    let mut entry: Option<InstalledGame> = None;
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
        {
            entry = map.get(&app_name).cloned();
        }
    }

    if entry.is_none() {
        let installed = cache::read_installed(&config);
        entry = installed.into_iter().find(|g| g.app_name == app_name);
    }

    let entry = entry.ok_or_else(|| "@t:manage.notInstalled".to_string())?;

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let target_exe = if !entry.executable.is_empty() {
            std::path::Path::new(&entry.install_path).join(&entry.executable)
        } else {
            let mut found = None;
            if let Ok(entries) = std::fs::read_dir(&entry.install_path) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) == Some("exe") {
                        found = Some(p);
                        break;
                    }
                }
            }
            found.unwrap_or_else(|| std::path::PathBuf::from(&entry.install_path))
        };

        let title_clean = desktop_shortcut_file_name(&entry.title).replace('\'', "''");
        // The shortcut must go through the launcher: `legendary launch` sets up the
        // arguments and environment Epic titles need. Pointing the shortcut at the
        // game exe directly made games start and close immediately.
        let launcher_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let launcher_dir = launcher_exe
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let ps = format!(
            "$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $lnk = Join-Path $d '{title_clean}'; $s = $ws.CreateShortcut($lnk); $s.TargetPath = '{}'; $s.Arguments = '--launch \"{}\"'; $s.WorkingDirectory = '{}'; $s.IconLocation = '{},0'; $s.Save()",
            launcher_exe.to_string_lossy().replace('\'', "''"),
            app_name.replace('\'', "''"),
            launcher_dir.to_string_lossy().replace('\'', "''"),
            target_exe.to_string_lossy().replace('\'', "''")
        );

        let output = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(format!("@t:manage.shortcutCreated\u{1f}{}", entry.title))
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(format!("@t:manage.shortcutCreateFailed\u{1f}{}", err))
        }
    }
    #[cfg(not(windows))]
    {
        Err("@t:manage.shortcutWindowsOnly".to_string())
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDlcItem {
    pub app_id: String,
    pub title: String,
    pub installed: bool,
    pub size: u64,
    pub image: Option<String>,
    #[serde(default = "default_true")]
    pub downloadable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDlcResponse {
    pub app_name: String,
    pub game_title: String,
    pub dlcs: Vec<GameDlcItem>,
}

#[tauri::command]
pub async fn epic_get_game_dlcs(app_name: String) -> Result<GameDlcResponse, String> {
    let config = skip::default_config_dir();
    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    if !meta_path.is_file() {
        return Ok(GameDlcResponse {
            app_name: app_name.clone(),
            game_title: app_name,
            dlcs: Vec::new(),
        });
    }

    let meta_raw = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&meta_raw).map_err(|e| e.to_string())?;

    let game_title = val
        .get("app_title")
        .and_then(|v| v.as_str())
        .or_else(|| val.pointer("/metadata/title").and_then(|v| v.as_str()))
        .unwrap_or(&app_name)
        .to_string();

    let main_catalog_id = val
        .pointer("/metadata/id")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    // 1. Read installed.json
    let installed_path = config.join("installed.json");
    let installed_map: serde_json::Value = if installed_path.is_file() {
        std::fs::read_to_string(&installed_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        serde_json::Value::Null
    };

    // 2. Read EGL manifests
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct EglItemCheck {
        app_name: Option<String>,
        display_name: Option<String>,
        main_game_app_name: Option<String>,
        install_size: Option<u64>,
    }
    let mut egl_items: Vec<EglItemCheck> = Vec::new();
    let egl_manifests_dir =
        std::path::Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    if egl_manifests_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(egl_manifests_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("item") {
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        if let Ok(item) = serde_json::from_str::<EglItemCheck>(&content) {
                            egl_items.push(item);
                        }
                    }
                }
            }
        }
    }

    // 3. Read entitlements.json (licenses the user bought/owns)
    let entitlements_path = config.join("entitlements.json");
    let mut owned_catalog_item_ids = std::collections::HashSet::new();
    let mut owned_entitlement_names = std::collections::HashSet::new();

    if entitlements_path.is_file() {
        if let Ok(ent_str) = std::fs::read_to_string(&entitlements_path) {
            if let Ok(ent_arr) = serde_json::from_str::<Vec<serde_json::Value>>(&ent_str) {
                for e in ent_arr {
                    let status = e.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");
                    if status == "ACTIVE" || status.is_empty() {
                        if let Some(id) = e.get("catalogItemId").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_catalog_item_ids.insert(id.trim().to_string());
                            }
                        }
                        if let Some(id) = e.get("entitlementName").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_entitlement_names.insert(id.trim().to_string());
                            }
                        }
                        if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_catalog_item_ids.insert(id.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Read assets.json (downloadable packages and CDN assets)
    let assets_path = config.join("assets.json");
    let mut asset_app_names = std::collections::HashSet::new();
    let mut asset_catalog_item_ids = std::collections::HashSet::new();
    let mut asset_ids = std::collections::HashSet::new();

    if assets_path.is_file() {
        if let Ok(assets_str) = std::fs::read_to_string(&assets_path) {
            if let Ok(assets_map) = serde_json::from_str::<
                std::collections::HashMap<String, Vec<serde_json::Value>>,
            >(&assets_str)
            {
                for (_plat, list) in assets_map {
                    for a in list {
                        if let Some(app) = a.get("app_name").and_then(|v| v.as_str()) {
                            if !app.trim().is_empty() {
                                asset_app_names.insert(app.trim().to_string());
                            }
                        }
                        if let Some(cat) = a.get("catalog_item_id").and_then(|v| v.as_str()) {
                            if !cat.trim().is_empty() {
                                asset_catalog_item_ids.insert(cat.trim().to_string());
                            }
                        }
                        if let Some(aid) = a.get("asset_id").and_then(|v| v.as_str()) {
                            if !aid.trim().is_empty() {
                                asset_ids.insert(aid.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let has_ownership_records = !owned_catalog_item_ids.is_empty() || !asset_app_names.is_empty();

    let mut dlcs = Vec::new();
    let mut seen_keys = std::collections::HashSet::new();

    if let Some(items) = val
        .pointer("/metadata/dlcItemList")
        .and_then(|v| v.as_array())
    {
        for item in items {
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if title.is_empty() {
                continue;
            }
            let title_lower = title.to_lowercase();
            // Skip internal test / placeholder audience entries (except meaningful package names)
            if (title_lower.ends_with("audience") || title_lower.starts_with("audience "))
                && !title_lower.contains("chapter")
                && !title_lower.contains("pack")
            {
                continue;
            }

            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
            let ent_name = item
                .get("entitlementName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let rel_app_id = item
                .pointer("/releaseInfo/0/appId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            // Ana oyunun kendisi DLC olarak listelenmemeli
            if (!main_catalog_id.is_empty()
                && (item_id == main_catalog_id || ent_name == main_catalog_id))
                || (!rel_app_id.is_empty() && rel_app_id == app_name)
            {
                continue;
            }

            let app_id = if !rel_app_id.is_empty() {
                rel_app_id
            } else if !item_id.is_empty() {
                item_id
            } else {
                ent_name
            };

            if app_id.is_empty() {
                continue;
            }

            // Prevent duplicate entries
            let dedup_key = format!("{}:{}", title.to_lowercase(), app_id.to_lowercase());
            if !seen_keys.insert(dedup_key) {
                continue;
            }

            // Kurulu olma durumu
            let is_in_legendary = installed_map.get(app_id).is_some()
                || (!item_id.is_empty() && installed_map.get(item_id).is_some());
            let matching_egl = egl_items.iter().find(|e| {
                e.app_name.as_deref() == Some(app_id)
                    || (!item_id.is_empty() && e.app_name.as_deref() == Some(item_id))
                    || (e.main_game_app_name.as_deref() == Some(&app_name)
                        && e.display_name.as_deref() == Some(title))
            });
            let is_installed = is_in_legendary || matching_egl.is_some();

            // Ownership check: ONLY what the user owns!
            let is_entitled = (!item_id.is_empty()
                && (owned_catalog_item_ids.contains(item_id)
                    || owned_entitlement_names.contains(item_id)))
                || (!ent_name.is_empty()
                    && (owned_catalog_item_ids.contains(ent_name)
                        || owned_entitlement_names.contains(ent_name)))
                || (!rel_app_id.is_empty()
                    && (owned_catalog_item_ids.contains(rel_app_id)
                        || owned_entitlement_names.contains(rel_app_id)));

            let is_asset = (!rel_app_id.is_empty()
                && (asset_app_names.contains(rel_app_id) || asset_ids.contains(rel_app_id)))
                || (!item_id.is_empty() && asset_catalog_item_ids.contains(item_id));

            let has_manifest = config
                .join("metadata")
                .join(format!("{app_id}.json"))
                .is_file();

            let is_owned = if has_ownership_records {
                is_entitled || is_asset || is_installed
            } else {
                is_installed || has_manifest
            };

            if !is_owned {
                continue;
            }

            // Downloadable state: can the Legendary CLI download this package independently?
            // Those with an entry in the assets list, a manifest on disk or already installed are downloadable;
            // account-bound in-game packs (e.g. DBD chapters) are shown as "Active on account".
            let is_downloadable = is_asset || has_manifest || is_installed;

            // Boyut hesaplama
            let mut size = matching_egl.and_then(|e| e.install_size).unwrap_or(0);
            if size == 0 {
                if let Some(g) = installed_map.get(app_id) {
                    size = g.get("install_size").and_then(|v| v.as_u64()).unwrap_or(0);
                }
            }
            if size == 0 {
                let dlc_meta_path = config.join("metadata").join(format!("{app_id}.json"));
                if dlc_meta_path.is_file() {
                    if let Ok(d_str) = std::fs::read_to_string(&dlc_meta_path) {
                        if let Ok(d_val) = serde_json::from_str::<serde_json::Value>(&d_str) {
                            if let Some(arr) = d_val
                                .pointer("/manifest/tag_disk_size")
                                .and_then(|v| v.as_array())
                            {
                                for t in arr {
                                    size += t.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                }
                            }
                        }
                    }
                }
            }

            // Cover image
            let mut image = None;
            if let Some(imgs) = item.get("keyImages").and_then(|v| v.as_array()) {
                for preferred in &[
                    "DieselGameBox",
                    "OfferImageWide",
                    "DieselGameBoxTall",
                    "Thumbnail",
                ] {
                    if let Some(img) = imgs
                        .iter()
                        .find(|i| i.get("type").and_then(|t| t.as_str()) == Some(*preferred))
                    {
                        image = img
                            .get("url")
                            .and_then(|u| u.as_str())
                            .map(|s| s.to_string());
                        if image.is_some() {
                            break;
                        }
                    }
                }
                if image.is_none() {
                    image = imgs
                        .first()
                        .and_then(|i| i.get("url"))
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string());
                }
            }

            dlcs.push(GameDlcItem {
                app_id: app_id.to_string(),
                title: title.to_string(),
                installed: is_installed,
                size,
                image,
                downloadable: is_downloadable,
            });
        }
    }

    // Also add DLCs that are not in dlcItemList but installed via EGL or manually
    for e in &egl_items {
        if e.main_game_app_name.as_deref() == Some(&app_name) {
            let e_app = e.app_name.as_deref().unwrap_or("");
            let e_title = e.display_name.as_deref().unwrap_or(e_app);
            if !e_app.is_empty() && !e_title.is_empty() {
                let dedup_key = format!("{}:{}", e_title.to_lowercase(), e_app.to_lowercase());
                if seen_keys.insert(dedup_key) {
                    dlcs.push(GameDlcItem {
                        app_id: e_app.to_string(),
                        title: e_title.to_string(),
                        installed: true,
                        size: e.install_size.unwrap_or(0),
                        image: None,
                        downloadable: true,
                    });
                }
            }
        }
    }

    Ok(GameDlcResponse {
        app_name,
        game_title,
        dlcs,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptionTag {
    pub tag: String,
    pub label: String,
    pub size: u64,
    pub download_size: u64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstallOptions {
    pub app_name: String,
    pub title: String,
    pub base_size: u64,
    pub base_download_size: u64,
    pub tags: Vec<InstallOptionTag>,
    pub dlcs: Vec<GameDlcItem>,
    pub has_options: bool,
}

fn json_u64(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| v.as_f64().map(|n| n as u64))
        .unwrap_or(0)
}

/// Base install/download bytes plus optional tag rows.
///
/// Legendary puts the real totals on `disk_size` / `download_size`. The tag
/// arrays stay empty when the game has no optional packs, so reading only
/// those arrays reports zero.
fn sizes_from_manifest(manifest: &serde_json::Value) -> (u64, u64, Vec<InstallOptionTag>) {
    let disk_total = manifest.get("disk_size").map(json_u64).unwrap_or(0);
    let download_total = manifest.get("download_size").map(json_u64).unwrap_or(0);
    let disk_tags = manifest.get("tag_disk_size").and_then(|v| v.as_array());
    let dl_tags = manifest.get("tag_download_size").and_then(|v| v.as_array());

    let mut base_size = 0u64;
    let mut base_download_size = 0u64;
    let mut tags = Vec::new();

    if let Some(d_tags) = disk_tags {
        for item in d_tags {
            let tag_name = item.get("tag").and_then(|v| v.as_str()).unwrap_or("");
            let size = item.get("size").map(json_u64).unwrap_or(0);
            let dl_size = dl_tags
                .and_then(|arr| {
                    arr.iter()
                        .find(|x| x.get("tag").and_then(|t| t.as_str()) == Some(tag_name))
                })
                .and_then(|x| x.get("size"))
                .map(json_u64)
                .unwrap_or(size);

            if tag_name.is_empty() {
                base_size = size;
                base_download_size = dl_size;
            } else if size > 0 || dl_size > 0 {
                let (label, category) = map_tag_label(tag_name);
                tags.push(InstallOptionTag {
                    tag: tag_name.to_string(),
                    label: label.to_string(),
                    size,
                    download_size: dl_size,
                    category: category.to_string(),
                });
            }
        }
    }

    if base_size == 0 {
        base_size = disk_total;
    }
    if base_download_size == 0 {
        base_download_size = if download_total > 0 {
            download_total
        } else {
            base_size
        };
    }
    (base_size, base_download_size, tags)
}

fn map_tag_label(tag: &str) -> (&'static str, &'static str) {
    match tag {
        "voice_de_de" => ("Deutsch", "languages"),
        "voice_fr_fr" => ("français", "languages"),
        "voice_es_es" => ("español (España)", "languages"),
        "voice_es_mx" => ("español (Latinoamérica)", "languages"),
        "voice_it_it" => ("italiano", "languages"),
        "voice_ja_jp" => ("日本語", "languages"),
        "voice_ko_kr" => ("한국어", "languages"),
        "voice_pl_pl" => ("polski", "languages"),
        "voice_pt_br" => ("português (Brasil)", "languages"),
        "voice_ru_ru" => ("русский", "languages"),
        "voice_zh_cn" => ("简体中文", "languages"),
        "voice_zh_tw" => ("繁體中文", "languages"),
        "voice_en_us" => ("English (US)", "languages"),
        "hires_textures" | "hi_res_textures" => ("@t:dlc.catHires", "extras"),
        "bonus_content" => ("@t:dlc.catBonus", "extras"),
        _ => {
            if tag.starts_with("voice_") || tag.contains("lang") {
                ("@t:dlc.catExtraLanguage", "languages")
            } else {
                ("@t:dlc.catExtraPack", "extras")
            }
        }
    }
}

#[tauri::command]
pub async fn epic_get_install_options(
    app: AppHandle,
    app_name: String,
) -> Result<GameInstallOptions, String> {
    let dlc_res = epic_get_game_dlcs(app_name.clone()).await?;
    let bin = resolve_or_err(&app)?;

    let mut base_size = 0u64;
    let mut base_download_size = 0u64;
    let mut tags = Vec::new();

    // Offline first. One online call only when the cached manifest has no sizes.
    let mut used_online = false;
    let info = match client::run_json::<serde_json::Value>(
        &bin,
        &["info", &app_name, "--offline", "--json"],
    )
    .await
    {
        Ok(val) => Some(val),
        Err(_) => {
            used_online = true;
            client::run_json::<serde_json::Value>(&bin, &["info", &app_name, "--json"])
                .await
                .ok()
        }
    };
    if let Some(val) = info.as_ref() {
        if let Some(manifest) = val.get("manifest") {
            let parsed = sizes_from_manifest(manifest);
            base_size = parsed.0;
            base_download_size = parsed.1;
            tags = parsed.2;
        }
    }
    if !used_online && base_size == 0 && base_download_size == 0 {
        if let Ok(val) =
            client::run_json::<serde_json::Value>(&bin, &["info", &app_name, "--json"]).await
        {
            if let Some(manifest) = val.get("manifest") {
                let parsed = sizes_from_manifest(manifest);
                base_size = parsed.0;
                base_download_size = parsed.1;
                tags = parsed.2;
            }
        }
    }

    let dlcs: Vec<GameDlcItem> = dlc_res
        .dlcs
        .into_iter()
        .filter(|d| d.downloadable)
        .collect();
    let has_options = !tags.is_empty() || !dlcs.is_empty();

    Ok(GameInstallOptions {
        app_name,
        title: dlc_res.game_title,
        base_size,
        base_download_size,
        tags,
        dlcs,
        has_options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_desktop_shortcut_file_name_matches_create_and_remove() {
        assert_eq!(
            desktop_shortcut_file_name("Cyberpunk 2077"),
            "Cyberpunk 2077.lnk"
        );
        assert_eq!(desktop_shortcut_file_name("A:B/C"), "A B C.lnk");
        assert_eq!(
            desktop_shortcut_file_name("  Alan Wake 2  "),
            "Alan Wake 2.lnk"
        );
    }

    #[test]
    fn test_sizes_from_manifest_uses_totals_when_tags_are_empty() {
        let manifest = serde_json::json!({
            "disk_size": 4_000_000_000u64,
            "download_size": 2_500_000_000u64,
            "tag_disk_size": [],
            "tag_download_size": []
        });
        let (disk, download, tags) = sizes_from_manifest(&manifest);
        assert_eq!(disk, 4_000_000_000);
        assert_eq!(download, 2_500_000_000);
        assert!(tags.is_empty());
    }

    #[test]
    fn test_sizes_from_manifest_keeps_base_tag_separate_from_optional() {
        let manifest = serde_json::json!({
            "disk_size": 5_000u64,
            "download_size": 4_000u64,
            "tag_disk_size": [
                {"tag": "", "size": 3_000u64},
                {"tag": "voice_de_de", "size": 2_000u64}
            ],
            "tag_download_size": [
                {"tag": "", "size": 2_200u64},
                {"tag": "voice_de_de", "size": 1_800u64}
            ]
        });
        let (disk, download, tags) = sizes_from_manifest(&manifest);
        assert_eq!(disk, 3_000);
        assert_eq!(download, 2_200);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].tag, "voice_de_de");
        assert_eq!(tags[0].size, 2_000);
    }

    #[test]
    fn test_epic_get_game_settings() {
        let res = epic_get_game_settings("19927295d6e3467887d4e830d8c85963".to_string());
        assert!(res.is_ok());
        let st = res.unwrap();
        assert_eq!(st.app_name, "19927295d6e3467887d4e830d8c85963");
        assert!(st.auto_update);
    }

    #[test]
    fn test_map_tag_label() {
        let (label_de, cat_de) = map_tag_label("voice_de_de");
        assert_eq!(label_de, "Deutsch");
        assert_eq!(cat_de, "languages");

        let (label_fr, cat_fr) = map_tag_label("voice_fr_fr");
        assert_eq!(label_fr, "français");
        assert_eq!(cat_fr, "languages");

        let (label_tex, cat_tex) = map_tag_label("hires_textures");
        assert_eq!(label_tex, "@t:dlc.catHires");
        assert_eq!(cat_tex, "extras");
    }

    /// Live check: reads the signed-in account's catalog metadata from disk.
    /// Run: `cargo test test_epic_get_game_dlcs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn test_epic_get_game_dlcs_ginger() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = epic_get_game_dlcs("Ginger".to_string()).await.unwrap();
            assert_eq!(res.game_title, "Cyberpunk 2077");
            let phantom = res
                .dlcs
                .iter()
                .find(|d| d.title.contains("Phantom Liberty"));
            assert!(phantom.is_some(), "Phantom Liberty DLC must be found");
            assert!(
                phantom.unwrap().installed,
                "Phantom Liberty must be installed"
            );
            assert!(
                phantom.unwrap().size > 0,
                "Phantom Liberty size must be greater than 0"
            );
            assert!(
                phantom.unwrap().downloadable,
                "Phantom Liberty must be downloadable"
            );
        });
    }

    /// Live check: DLC ownership is account specific, so this only runs on demand
    /// against whatever account is signed in on this machine.
    /// Run: `cargo test test_epic_get_game_dlcs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn test_epic_get_game_dlcs_brill_only_owned() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = epic_get_game_dlcs("Brill".to_string()).await.unwrap();
            assert_eq!(res.game_title, "Dead by Daylight");
            // Only the 4 DLCs the user owns must be returned (not the 74 catalog DLCs!)
            assert!(
                res.dlcs.len() <= 6,
                "Only owned DLCs must be returned, found: {}",
                res.dlcs.len()
            );
            // Unowned DLCs (e.g. Castlevania or Doomed Course or unreleased) must NEVER be returned!
            let unowned = res.dlcs.iter().find(|d| {
                d.title.contains("Castlevania")
                    || d.title.contains("Doomed Course")
                    || d.app_id == "a2a562015e724c0ea4ba052c62c9cdee"
            });
            assert!(
                unowned.is_none(),
                "Unowned store DLCs must absolutely be filtered out!"
            );
            // One of the owned DLCs (e.g. Halloween Chapter or Silent Hill) must be found
            let halloween = res
                .dlcs
                .iter()
                .find(|d| d.title.contains("Halloween") || d.title.contains("Silent Hill"));
            assert!(
                halloween.is_some(),
                "A DLC owned by the user must be listed"
            );
            // Dead by Daylight DLCs are account licenses, so downloadable must be false
            if let Some(h) = halloween {
                assert!(
                    !h.downloadable,
                    "DBD account-license DLCs must have downloadable: false"
                );
            }
        });
    }
}
