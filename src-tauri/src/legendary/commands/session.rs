//! Epic setup, library listing, and account session commands.

use super::prelude::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub needs_download: bool,
}

#[tauri::command]
pub async fn epic_setup_status(app: AppHandle) -> Result<SetupStatus, String> {
    let path = paths::resolve_binary(&app).ok();
    let mut version = None;
    if let Some(ref p) = path {
        // Cached: `legendary -V` boots a Python runtime (1.6 s measured) and its
        // answer only changes when the binary is replaced.
        version = downloader::binary_version_cached(p).await.ok();
    }
    let needs_download = version.is_none();
    Ok(SetupStatus {
        binary_path: path.map(|p| p.to_string_lossy().to_string()),
        version,
        needs_download,
    })
}

#[tauri::command]
pub async fn epic_ensure_binary(app: AppHandle) -> Result<String, String> {
    downloader::ensure_binary(&app)
        .await
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| fail(&app, e))
}

#[tauri::command]
pub async fn epic_list_games(app: AppHandle) -> Result<Vec<LegendaryGame>, String> {
    let bin = resolve_or_err(&app)?;
    let config_dir = config_dir_for(&bin).await;
    let mut games: Vec<LegendaryGame> =
        run_with_recovery(&app, &bin, &config_dir, &["list", "-T", "--json"]).await?;
    for g in &mut games {
        slim_game(g);
    }
    // Refresh the consolidated snapshot so the next cold start is instant.
    if !games.is_empty() {
        let config = skip::default_config_dir();
        cache::write_library_snapshot(&config, &games);
        crate::legendary::accounts::archive_active_sidecars(&config);
    }
    Ok(games)
}

#[tauri::command]
pub fn epic_list_skipped(app: AppHandle) -> Vec<String> {
    skip::load_skipped(&app)
        .into_iter()
        .map(|s| s.app_name)
        .collect()
}

/// Instant library from the disk cache (no network, no subprocess).
/// The UI shows this first; the `epic_list_games` sync runs in the background.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLibrary {
    pub account: Option<String>,
    pub account_id: Option<String>,
    pub games: Vec<LegendaryGame>,
    pub installed: Vec<InstalledGame>,
    pub skipped: Vec<String>,
    pub collections: Vec<crate::legendary::collections::GameCollection>,
}

#[tauri::command]
pub async fn epic_cached_library(app: AppHandle) -> CachedLibrary {
    // Reads and parses ~900 metadata files: run on a blocking thread so the
    // main thread / UI never stalls on a slow HDD.
    tauri::async_runtime::spawn_blocking(move || {
        let config = skip::default_config_dir();
        let (account, account_id) = match cache::read_user(&config) {
            Some((name, id)) => (Some(name), id),
            None => (None, None),
        };
        // Prefer the consolidated snapshot (1 file) over parsing ~900 files.
        let games = match cache::read_library_snapshot(&config) {
            Some(g) => g,
            None => {
                let g = cache::read_cached_games(&config);
                cache::write_library_snapshot(&config, &g);
                g
            }
        };
        // The snapshot above already holds every catalog entry, so third-party
        // detection does not re-read 820 metadata files (measured 3.0 s before).
        let installed = cache::read_installed_with_catalog(&config, Some(&games));
        let skipped: Vec<String> = skip::load_skipped(&app)
            .into_iter()
            .map(|s| s.app_name)
            .collect();
        let collections = crate::legendary::collections::read_collections().unwrap_or_default();
        CachedLibrary {
            account,
            account_id,
            games,
            installed,
            skipped,
            collections,
        }
    })
    .await
    .unwrap_or_else(|err| {
        // A panicking scan must not hand the UI an empty library without a trace.
        eprintln!("[library] cached library scan failed: {err}");
        CachedLibrary::default()
    })
}

#[tauri::command]
pub async fn epic_list_installed(_app: AppHandle) -> Result<Vec<InstalledGame>, String> {
    let config = skip::default_config_dir();
    Ok(cache::read_installed(&config))
}

/// Accepts a raw code or a JSON body containing `authorizationCode`,
/// exactly as legendary does.
fn extract_auth_code(input: &str) -> Result<String, LegendaryError> {
    use LegendaryError;
    let t = input.trim();
    if t.is_empty() {
        return Err(LegendaryError::ParseError("@t:auth.codeEmpty".into()));
    }
    if t.starts_with('{') {
        let v: serde_json::Value =
            serde_json::from_str(t).map_err(|e| LegendaryError::ParseError(e.to_string()))?;
        return v
            .get("authorizationCode")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| LegendaryError::ParseError("@t:auth.noAuthCode".into()));
    }
    Ok(t.trim_matches('"').trim().to_string())
}

#[tauri::command]
pub async fn epic_login_with_code(app: AppHandle, code: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    let code = extract_auth_code(&code).map_err(|e| fail(&app, e))?;
    let config_dir = skip::default_config_dir();
    // Archive the open session before auth replaces user.json.
    crate::legendary::accounts::ensure_current_account_saved(&config_dir);
    // -y first: an existing session would otherwise wait for a yes/no that never arrives.
    client::run_unit(&bin, &["-y", "auth", "--code", &code])
        .await
        .map_err(|e| fail(&app, e))?;
    let st: LegendaryStatus = client::run_json(&bin, &["status", "--offline", "--json"])
        .await
        .map_err(|e| fail(&app, e))?;
    crate::legendary::accounts::discard_shared_session_cache(&config_dir);
    crate::legendary::accounts::ensure_current_account_saved(&config_dir);
    Ok(st.account)
}

#[tauri::command]
pub async fn epic_import_egl(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    // Ensure EGL Saved\Config\Windows path exists for Legendary CLI on Windows.
    // Modern Epic Games Launcher often places GameUserSettings.ini in WindowsEditor instead of Windows,
    // which causes legendary to fail with "ValueError('EGS AppData path does not exist')".
    // We bridge this automatically so import works smoothly.
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let base = std::path::Path::new(&local_appdata)
                .join("EpicGamesLauncher")
                .join("Saved")
                .join("Config");
            let win_path = base.join("Windows");
            let win_editor_path = base.join("WindowsEditor");
            if win_editor_path.exists() {
                let src_ini = win_editor_path.join("GameUserSettings.ini");
                if src_ini.exists() {
                    let _ = std::fs::create_dir_all(&win_path);
                    let dst_ini = win_path.join("GameUserSettings.ini");
                    let _ = std::fs::copy(&src_ini, &dst_ini);
                }
            }
        }
    }
    let config_dir = skip::default_config_dir();
    crate::legendary::accounts::ensure_current_account_saved(&config_dir);
    client::run_unit(&bin, &["-y", "auth", "--import"])
        .await
        .map_err(|e| fail(&app, e))?;
    let st: LegendaryStatus = client::run_json(&bin, &["status", "--offline", "--json"])
        .await
        .map_err(|e| fail(&app, e))?;
    crate::legendary::accounts::discard_shared_session_cache(&config_dir);
    crate::legendary::accounts::ensure_current_account_saved(&config_dir);
    Ok(st.account)
}

#[tauri::command]
pub async fn epic_logout(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    client::run_unit(&bin, &["-y", "auth", "--delete"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok("@t:auth.loggedOut".into())
}

#[tauri::command]
pub fn epic_get_saved_accounts(
    _app: AppHandle,
) -> Result<Vec<crate::legendary::accounts::SavedAccount>, String> {
    let config_dir = skip::default_config_dir();
    Ok(crate::legendary::accounts::list_saved_accounts(&config_dir))
}

#[tauri::command]
pub fn epic_switch_account(
    _app: AppHandle,
    account_id: String,
) -> Result<crate::legendary::accounts::SavedAccount, String> {
    let config_dir = skip::default_config_dir();
    crate::legendary::accounts::switch_account(&config_dir, &account_id)
}

#[tauri::command]
pub fn epic_remove_saved_account(_app: AppHandle, account_id: String) -> Result<(), String> {
    let config_dir = skip::default_config_dir();
    crate::legendary::accounts::remove_saved_account(&config_dir, &account_id)
}

#[tauri::command]
pub fn epic_get_settings(app: AppHandle) -> crate::EpicSettings {
    load_settings(&app)
}
