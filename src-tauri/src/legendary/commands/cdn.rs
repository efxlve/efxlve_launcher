//! Epic download CDN probe and preferred-host setting.

use super::prelude::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdnProbe {
    pub host: String,
    pub url: String,
    pub ms: u64,
}

/// Canonical Epic Games Store download CDN hosts and ping endpoints.
pub const DEFAULT_EPIC_CDNS: &[(&str, &str)] = &[
    (
        "egdownload.fastly-edge.com",
        "https://egdownload.fastly-edge.com/",
    ),
    (
        "epicgames-download1.akamaized.net",
        "https://epicgames-download1.akamaized.net/",
    ),
    (
        "egs-cloudfront-chunks.epicgamescdn.com",
        "https://egs-cloudfront-chunks.epicgamescdn.com/",
    ),
];

/// Collects unique CDN targets from both game `base_urls` and canonical Epic CDNs.
pub fn build_cdn_targets(base_urls: &[String]) -> Vec<(String, String)> {
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    let mut targets: Vec<(String, String)> = Vec::new();
    for raw in base_urls {
        let parsed = match url::Url::parse(raw) {
            Ok(u) => u,
            Err(_) => continue,
        };
        if let Some(host) = parsed.host_str() {
            let host = host.to_string();
            if seen.insert(host.clone()) {
                targets.push((host, raw.clone()));
            }
        }
    }
    for &(host, fallback_url) in DEFAULT_EPIC_CDNS {
        if seen.insert(host.to_string()) {
            targets.push((host.to_string(), fallback_url.to_string()));
        }
    }
    targets
}

/// Measures time-to-first-byte for each unique CDN host in `base_urls` and canonical Epic CDNs.
/// Used to pick the fastest CDN (`--preferred-cdn`) before installing.
#[tauri::command]
pub async fn epic_measure_cdns(base_urls: Vec<String>) -> Result<Vec<CdnProbe>, String> {
    use std::time::{Duration, Instant};

    let targets = build_cdn_targets(&base_urls);
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let mut handles = Vec::with_capacity(targets.len());
    for (host, url) in targets {
        handles.push(tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .user_agent("EpicGamesLauncher/11.0.1")
                .timeout(Duration::from_secs(4))
                .build()
                .ok()?;
            let start = Instant::now();
            let ok = client
                .get(&url)
                .header("Range", "bytes=0-0")
                .send()
                .await
                .is_ok();
            if !ok {
                return None;
            }
            Some(CdnProbe {
                host,
                url,
                ms: start.elapsed().as_millis() as u64,
            })
        }));
    }

    let mut probes = Vec::new();
    for h in handles {
        if let Ok(Some(p)) = h.await {
            probes.push(p);
        }
    }
    probes.sort_by_key(|p| p.ms);
    Ok(probes)
}

/// Persists the preferred CDN hostname (empty clears it).
#[tauri::command]
pub fn epic_set_preferred_cdn(app: AppHandle, host: Option<String>) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.preferred_cdn = host.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    save_settings(&app, &s);
    Ok(())
}

/// Removes legendary's temporary, metadata and manifest files.
#[tauri::command]
pub async fn epic_cleanup_cache(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    client::run_unit(&bin, &["cleanup"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok("@t:dl.cacheCleared".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_build_cdn_targets_includes_defaults() {
        let targets = build_cdn_targets(&[]);
        assert_eq!(targets.len(), 3);
        assert!(targets
            .iter()
            .any(|(h, _)| h == "egdownload.fastly-edge.com"));
        assert!(targets
            .iter()
            .any(|(h, _)| h == "epicgames-download1.akamaized.net"));
        assert!(targets
            .iter()
            .any(|(h, _)| h == "egs-cloudfront-chunks.epicgamescdn.com"));
    }

    #[test]
    fn test_build_cdn_targets_deduplicates_and_keeps_custom_url() {
        let custom = vec!["https://epicgames-download1.akamaized.net/custom/path".to_string()];
        let targets = build_cdn_targets(&custom);
        assert_eq!(targets.len(), 3);
        let akamai = targets
            .iter()
            .find(|(h, _)| h == "epicgames-download1.akamaized.net")
            .unwrap();
        assert_eq!(
            akamai.1,
            "https://epicgames-download1.akamaized.net/custom/path"
        );
    }
}
