//! GOG update checking.
//!
//! GOG Galaxy compares the installed build id (from `goggame-<id>.info`) with
//! the newest public build on the content system. The builds endpoint is public,
//! so this launcher can do the same check without an extra login. Results are
//! cached on disk for a few hours because each game is one HTTP request.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::api_client::fetch_latest_build;
use super::cache::load_installed_games;
use super::models::{GogBuildInfo, GogUpdateInfo};

/// How long a cached build lookup stays valid.
const CACHE_TTL_SECS: u64 = 6 * 60 * 60;
/// How many games are queried in parallel per batch.
const BATCH: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CachedBuild {
    build_id: String,
    #[serde(default)]
    version_name: String,
    #[serde(default)]
    date_published: String,
    checked_at: u64,
}

fn cache_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("gog_updates.json")
}

fn load_cache(app: &AppHandle) -> HashMap<String, CachedBuild> {
    std::fs::read_to_string(cache_path(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_cache(app: &AppHandle, cache: &HashMap<String, CachedBuild>) {
    if let Ok(json) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(cache_path(app), json);
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True when the cached build lookup is still inside the TTL.
fn is_fresh(entry: &CachedBuild, now: u64, force: bool) -> bool {
    !force && now.saturating_sub(entry.checked_at) < CACHE_TTL_SECS
}

/// True when a newer public build exists. Either side being unknown means we
/// cannot tell, so no update is reported (never guess).
pub fn has_update(installed_build: &str, latest_build: &str) -> bool {
    !installed_build.is_empty() && !latest_build.is_empty() && installed_build != latest_build
}

/// Stores the freshly installed build so the next check does not re-fetch it.
/// Called after a successful gogdl install/update.
pub fn store_installed_build(app: &AppHandle, game_id: &str, build_id: &str, version: &str) {
    if build_id.is_empty() {
        return;
    }
    let mut cache = load_cache(app);
    cache.insert(
        game_id.to_string(),
        CachedBuild {
            build_id: build_id.to_string(),
            version_name: version.to_string(),
            date_published: String::new(),
            checked_at: now_secs(),
        },
    );
    save_cache(app, &cache);
}

/// Compares every installed game's build id with the newest public build.
/// `force` ignores the disk cache (used by a manual refresh).
pub async fn check_updates(app: &AppHandle, force: bool) -> Result<Vec<GogUpdateInfo>, String> {
    let installed = load_installed_games(app);
    let mut cache = load_cache(app);
    let now = now_secs();

    // Games whose build id we know and whose cache entry is stale.
    let mut pending: Vec<String> = Vec::new();
    for (id, info) in &installed {
        if info.build_id.is_empty() {
            continue;
        }
        let fresh = cache
            .get(id)
            .map(|c| is_fresh(c, now, force))
            .unwrap_or(false);
        if !fresh && !pending.contains(id) {
            pending.push(id.clone());
        }
    }

    for chunk in pending.chunks(BATCH) {
        let mut handles = Vec::new();
        for id in chunk {
            let id = id.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let build = fetch_latest_build(&id).await.ok().flatten();
                (id, build)
            }));
        }
        for handle in handles {
            if let Ok((id, Some(build))) = handle.await {
                let entry = CachedBuild {
                    build_id: build.build_id,
                    version_name: build.version_name,
                    date_published: build.date_published,
                    checked_at: now,
                };
                cache.insert(id, entry);
            }
        }
    }
    save_cache(app, &cache);

    let mut out: Vec<GogUpdateInfo> = Vec::new();
    for (id, info) in &installed {
        if info.build_id.is_empty() {
            continue;
        }
        let Some(cached) = cache.get(id) else {
            continue;
        };
        if !has_update(&info.build_id, &cached.build_id) {
            continue;
        }
        out.push(GogUpdateInfo {
            game_id: id.clone(),
            installed_build_id: info.build_id.clone(),
            latest_build_id: cached.build_id.clone(),
            latest_version: cached.version_name.clone(),
            date_published: cached.date_published.clone(),
        });
    }
    out.sort_by(|a, b| a.game_id.cmp(&b.game_id));
    Ok(out)
}

/// Cached latest build for one game, if it was checked before.
#[allow(dead_code)]
pub fn cached_build(app: &AppHandle, game_id: &str) -> Option<GogBuildInfo> {
    load_cache(app).get(game_id).map(|c| GogBuildInfo {
        build_id: c.build_id.clone(),
        version_name: c.version_name.clone(),
        date_published: c.date_published.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_respects_ttl_and_force() {
        let entry = CachedBuild {
            build_id: "1".into(),
            checked_at: 1_000,
            ..Default::default()
        };
        // Checked 5 minutes ago -> fresh.
        assert!(is_fresh(&entry, 1_300, false));
        // Checked just over the TTL ago -> stale.
        assert!(!is_fresh(&entry, 1_000 + CACHE_TTL_SECS + 1, false));
        // A manual refresh always re-checks.
        assert!(!is_fresh(&entry, 1_001, true));
    }

    #[test]
    fn update_detection_never_guesses() {
        assert!(has_update("100", "200"));
        assert!(!has_update("200", "200"));
        // Unknown installed or latest build: report nothing.
        assert!(!has_update("", "200"));
        assert!(!has_update("100", ""));
        assert!(!has_update("", ""));
    }
}
