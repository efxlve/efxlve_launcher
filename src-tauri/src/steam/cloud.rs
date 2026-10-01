//! Last Steam Cloud write time for one app (`remotecache.vdf`).
//!
//! Read-only. The app id is digits only, so the path cannot leave `userdata`.

use serde::Serialize;

use super::runtime::steam_install_path;
use super::users::active_steam_id;
use super::vdf::{parse_vdf, Vdf};

/// Last Steam Cloud write time for one app, read from `userdata/.../remotecache.vdf`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamCloudStatus {
    pub app_id: String,
    /// Unix seconds of the newest remotecache timestamp, if Steam wrote one.
    pub last_sync: Option<i64>,
}

pub(super) const STEAM64_BASE: u64 = 7_656_119_796_026_5728;

pub(super) fn account_id_from_steam64(id: &str) -> Option<String> {
    let n: u64 = id.parse().ok()?;
    if n >= STEAM64_BASE {
        Some((n - STEAM64_BASE).to_string())
    } else {
        Some(id.to_string())
    }
}

pub(super) fn max_sync_unix(node: &Vdf) -> Option<i64> {
    let mut best: Option<i64> = None;
    walk_sync_unix(node, &mut best);
    best
}

pub(super) fn walk_sync_unix(node: &Vdf, best: &mut Option<i64>) {
    for (k, v) in node.entries() {
        let key = k.to_ascii_lowercase();
        if matches!(
            key.as_str(),
            "time" | "synctime" | "remotetime" | "localtime"
        ) {
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    if n > 1_000_000 {
                        *best = Some(best.map_or(n, |b| b.max(n)));
                    }
                }
            }
        }
        walk_sync_unix(v, best);
    }
}

/// Reads Steam Cloud's last write for `app_id`, or `last_sync: null` when unknown.
#[tauri::command]
pub fn steam_cloud_status(app_id: String) -> SteamCloudStatus {
    let id = app_id.trim().trim_start_matches("steam::").to_string();
    let empty = SteamCloudStatus {
        app_id: id.clone(),
        last_sync: None,
    };
    // Digits only. `Path::join` would walk out of userdata on `..` or a slash.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return SteamCloudStatus {
            app_id: String::new(),
            last_sync: None,
        };
    }
    let Some(steam) = steam_install_path() else {
        return empty;
    };
    let Some(user) = active_steam_id(&steam) else {
        return empty;
    };
    let account = account_id_from_steam64(&user).unwrap_or_else(|| user.clone());
    let paths = [
        steam
            .join("userdata")
            .join(&account)
            .join(&id)
            .join("remotecache.vdf"),
        steam
            .join("userdata")
            .join(&user)
            .join(&id)
            .join("remotecache.vdf"),
    ];
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(ts) = max_sync_unix(&parse_vdf(&text)) {
            return SteamCloudStatus {
                app_id: id,
                last_sync: Some(ts),
            };
        }
    }
    empty
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::vdf::parse_vdf;

    const REMOTECACHE: &str = r#"
    "730"
    {
    	"save.dat"
    	{
    		"size"		"12"
    		"localtime"		"1700000000"
    		"time"		"1700000100"
    		"remotetime"		"1700000200"
    	}
    }
    "#;

    #[test]
    fn remotecache_reads_newest_unix_time() {
        let root = parse_vdf(REMOTECACHE);
        assert_eq!(max_sync_unix(&root), Some(1_700_000_200));
    }
    #[test]
    fn steamid64_becomes_account_id() {
        assert_eq!(
            account_id_from_steam64("76561197960265729").as_deref(),
            Some("1")
        );
        assert_eq!(account_id_from_steam64("12345").as_deref(), Some("12345"));
    }
    #[test]
    fn cloud_status_rejects_a_path() {
        let status = steam_cloud_status(r"..\Windows".into());
        assert!(status.last_sync.is_none());
        assert!(status.app_id.is_empty());
    }
}
