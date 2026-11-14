//! Selective download (SDL) groups, the way legendary models them.
//!
//! Legendary keeps the groups for a game at `<config>/tmp/<app>.json` and
//! fetches them from `api.legendary.gl`. The launcher reads the same data so
//! the install dialog can offer the groups instead of Fortnite's internal
//! chunk names, and so a selected group never drops the required tags.
//!
//! `--install-tag` filters the manifest to files carrying one of the listed
//! tags. A selection that leaves out `""` and `__required` therefore installs
//! only the optional packs and no playable game.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

const SDL_API: &str = "https://api.legendary.gl/v1/sdl";
/// The groups are a small JSON file; a slow API must not hold the dialog.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

fn cache_path(config: &Path, app_name: &str) -> PathBuf {
    config.join("tmp").join(format!("{app_name}.json"))
}

/// True when the value looks like legendary's `{group: {name, tags}}` map.
fn is_groups(data: &Value) -> bool {
    data.as_object().is_some_and(|groups| {
        groups.values().any(|group| {
            group
                .get("tags")
                .and_then(|tags| tags.as_array())
                .is_some_and(|tags| !tags.is_empty())
        })
    })
}

/// Reads the SDL groups from legendary's cache. The file wraps the groups in
/// `{version, data}`; older payloads are the bare map.
pub(crate) fn read_groups(config: &Path, app_name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(cache_path(config, app_name)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let data = value.get("data").unwrap_or(&value);
    is_groups(data).then(|| data.clone())
}

/// Fetches the groups from legendary's API. `None` on any failure; callers
/// fall back to the raw manifest tags.
pub(crate) async fn fetch_groups(app_name: &str) -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(format!("{SDL_API}/{app_name}.json"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data = response.json::<Value>().await.ok()?;
    is_groups(&data).then_some(data)
}

/// The SDL version legendary compares against its cached copy. 0 when the
/// cached version file is missing; legendary then refetches and replaces the
/// identical data.
pub(crate) fn sdl_version(config: &Path, app_name: &str) -> u64 {
    std::fs::read_to_string(config.join("version.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .pointer(&format!("/game_overrides/sdl_config/{app_name}"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0)
}

/// Writes the groups in legendary's cache shape so its own `--skip-sdl` and a
/// later install see the same data without another API call.
pub(crate) fn save_groups(config: &Path, app_name: &str, data: &Value, version: u64) {
    let path = cache_path(config, app_name);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "version": version, "data": data });
    if let Ok(text) = serde_json::to_string(&body) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn group_tags<'a>(groups: &'a Value, key: &str) -> Vec<&'a str> {
    groups
        .get(key)
        .and_then(|group| group.get("tags"))
        .and_then(|tags| tags.as_array())
        .map(|tags| tags.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

pub(crate) fn group_name(groups: &Value, key: &str) -> String {
    groups
        .get(key)
        .and_then(|group| group.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(key)
        .to_string()
}

/// Required tags plus every selected group, always with the untagged set.
/// Sorted and deduplicated so a group that repeats a required tag is not
/// counted twice.
pub(crate) fn expanded_tags(groups: &Value, selected: &[String]) -> Vec<String> {
    let mut tags = vec![String::new()];
    tags.extend(
        group_tags(groups, "__required")
            .into_iter()
            .map(str::to_string),
    );
    for key in selected {
        let group = group_tags(groups, key);
        if group.is_empty() {
            // A raw manifest tag from an older dialog (or a legacy resume
            // record) is kept as-is; required tags are still added above.
            tags.push(key.clone());
        } else {
            tags.extend(group.into_iter().map(str::to_string));
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

/// Expands a selection against the app's SDL groups. With no cached groups the
/// selection is returned unchanged; `--skip-sdl` is still safe because
/// legendary uses its own SDL cache or the required tags from the API.
pub(crate) fn expand_selected(app_name: &str, selected: Vec<String>) -> Vec<String> {
    if selected.is_empty() {
        return selected;
    }
    let config = crate::legendary::skip::default_config_dir();
    match read_groups(&config, app_name) {
        Some(groups) => expanded_tags(&groups, &selected),
        None => selected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_groups() -> Value {
        serde_json::json!({
            "__required": {
                "name": "Core",
                "tags": ["CoreChunk", "Globals", ""]
            },
            "assets": {
                "name": "Epic Quality Assets",
                "tags": ["AssetsChunk", "AssetsOptional"]
            }
        })
    }

    #[test]
    fn a_selected_group_keeps_the_required_tags() {
        let tags = expanded_tags(&sample_groups(), &["assets".to_string()]);
        assert!(tags.iter().any(|tag| tag.is_empty()));
        assert!(tags.iter().any(|tag| tag == "CoreChunk"));
        assert!(tags.iter().any(|tag| tag == "Globals"));
        assert!(tags.iter().any(|tag| tag == "AssetsChunk"));
        assert_eq!(
            tags.iter()
                .filter(|tag| tag.as_str() == "AssetsOptional")
                .count(),
            1
        );
        // The expansion is only reached with a non-empty selection; it always
        // carries the untagged set and the required tags.
        let base = expanded_tags(&sample_groups(), &[]);
        assert!(base.iter().any(|tag| tag.is_empty()));
        assert!(base.iter().any(|tag| tag == "CoreChunk"));
    }

    #[test]
    fn a_legacy_raw_tag_is_kept_after_the_required_tags() {
        let tags = expanded_tags(&sample_groups(), &["OldRawTag".to_string()]);
        assert!(tags.iter().any(|tag| tag == "CoreChunk"));
        assert!(tags.iter().any(|tag| tag == "OldRawTag"));
    }

    #[test]
    fn a_group_repeating_a_required_tag_is_not_counted_twice() {
        let groups = serde_json::json!({
            "__required": { "tags": ["Shared", ""] },
            "extra": { "tags": ["Shared", "Only"] }
        });
        let tags = expanded_tags(&groups, &["extra".to_string()]);
        assert_eq!(
            tags.iter().filter(|tag| tag.as_str() == "Shared").count(),
            1
        );
    }
}
