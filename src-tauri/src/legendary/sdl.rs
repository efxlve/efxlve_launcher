//! Selective download (SDL) groups, the way legendary models them.
//!
//! Legendary keeps the groups for a game at `<config>/tmp/<app>.json` and
//! fetches them from `api.legendary.gl`. The launcher reads the same data so
//! the install dialog can offer the groups instead of Fortnite's internal
//! chunk names, and so a selected group never drops the required tags.
//!
//! Epic's launcher goes further than the API for Fortnite: its optional
//! add-on groups are checkboxes. `with_launcher_groups` adds the launcher-only
//! groups on top of Epic's data. Fortnite's five game-mode roots stay in
//! `__required`: removing them makes the game load shared mode assets that are
//! no longer on disk and crash.
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

/// One install group the Epic launcher offers but legendary's SDL data does
/// not separate.
struct LauncherGroup {
    key: &'static str,
    name: &'static str,
    category: &'static str,
    default: bool,
    tags: &'static [&'static str],
}

/// Launcher-only groups on top of Epic's SDL data. Fortnite's five mode roots
/// are *not* here: Epic lists them under `__required`, and a missing mode pack
/// leaves the game unable to load shared seasonal assets. Only the optional
/// high-quality asset pack is a separate choice.
const FORTNITE_GROUPS: &[LauncherGroup] = &[LauncherGroup {
    key: "high_quality_assets",
    name: "High Quality Assets",
    category: "extras",
    default: false,
    tags: &["FortniteBRHighOptionalInstall", "FortniteBRHighOnDemand"],
}];

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

/// Adds the launcher-only groups to Epic's SDL data. Games without
/// launcher-only groups come back as they are.
pub(crate) fn with_launcher_groups(app_name: &str, groups: &Value) -> Value {
    let Some(mut out) = groups.as_object().cloned() else {
        return groups.clone();
    };
    if !app_name.eq_ignore_ascii_case("Fortnite") {
        return Value::Object(out);
    }
    for group in FORTNITE_GROUPS {
        out.entry(group.key.to_string()).or_insert_with(|| {
            serde_json::json!({
                "name": group.name,
                "tags": group.tags,
                "category": group.category,
                "default": group.default,
            })
        });
    }
    Value::Object(out)
}

/// Groups the launcher preselects when the user opens the install options.
fn default_group_keys(groups: &Value) -> Vec<String> {
    groups
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(key, group)| {
                    key.as_str() != "__required"
                        && group
                            .get("default")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                })
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default()
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
    // An empty selection is a legacy record or an update: it keeps the packs
    // the launcher preselects. The dialog sends the untagged tag for an
    // explicit "required content only".
    let keys = if selected.is_empty() {
        default_group_keys(groups)
    } else {
        selected.to_vec()
    };
    for key in &keys {
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

/// Last known SDL groups for titles whose API data may be unreachable. The
/// cache and the API always win; this only keeps an offline install from
/// falling back to legendary's stale hardcoded tags.
pub(crate) fn fallback_groups(app_name: &str) -> Option<Value> {
    if !app_name.eq_ignore_ascii_case("Fortnite") {
        return None;
    }
    serde_json::from_str(include_str!("sdl_fortnite.json")).ok()
}

/// Loads the groups for the install options: cache first, then the API, then
/// the bundled Fortnite data. Launcher-only groups are added on top.
pub(crate) async fn load_groups(config: &Path, app_name: &str) -> Option<Value> {
    let groups = match read_groups(config, app_name) {
        Some(groups) => groups,
        None => {
            let fetched = fetch_groups(app_name).await;
            if let Some(data) = fetched.as_ref() {
                let version = sdl_version(config, app_name);
                save_groups(config, app_name, data, version);
            }
            fetched.or_else(|| fallback_groups(app_name))?
        }
    };
    Some(with_launcher_groups(app_name, &groups))
}

/// Cached SDL groups without a network fetch. Update and repair paths use this:
/// a missing cache must not add an API round trip before a download starts.
pub(crate) fn cached_groups(config: &Path, app_name: &str) -> Option<Value> {
    read_groups(config, app_name)
        .or_else(|| fallback_groups(app_name))
        .map(|groups| with_launcher_groups(app_name, &groups))
}

/// Expands a selection against the app's SDL groups. The required and untagged
/// tags are always included, even with an empty selection, so the install never
/// depends on legendary's own (possibly stale) fallback.
pub(crate) fn expand_selected(app_name: &str, selected: Vec<String>) -> Vec<String> {
    let config = crate::legendary::skip::default_config_dir();
    match cached_groups(&config, app_name) {
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
        // The required and untagged tags are always included, so an empty
        // selection still installs the base.
        let base = expanded_tags(&sample_groups(), &[]);
        assert!(base.iter().any(|tag| tag.is_empty()));
        assert!(base.iter().any(|tag| tag == "CoreChunk"));
    }

    #[test]
    fn the_fortnite_fallback_keeps_the_required_tags() {
        let groups = fallback_groups("fortnite").expect("Fortnite fallback data");
        let required = group_tags(&groups, "__required");
        assert!(required.contains(&"Startup"));
        assert!(required.contains(&"FortniteBR"));
        // Every game mode is part of Epic's required set. Removing one leaves
        // shared seasonal content unreadable and the game crashes.
        for mode in [
            "GFP_CreativeRoot",
            "GFP_JunoRoot",
            "GFP_Sparks",
            "GFP_BlitzRoot",
            "GFP_SaveTheWorldRoot",
        ] {
            assert!(required.contains(&mode), "{mode} must stay required");
        }
        assert!(required.iter().any(|tag| tag.is_empty()));
        assert!(fallback_groups("SomeOtherGame").is_none());
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

    #[test]
    fn fortnite_modes_stay_in_the_required_set() {
        let groups = with_launcher_groups(
            "Fortnite",
            &fallback_groups("Fortnite").expect("Fortnite fallback data"),
        );
        let required = group_tags(&groups, "__required");
        assert!(required.contains(&"GFP_JunoRoot"));
        assert!(required.contains(&"GFP_SaveTheWorldRoot"));
        assert!(required.contains(&"GFP_CreativeRoot"));
        assert!(required.contains(&"FortniteBR"));
        // The mode roots are no longer optional rows of their own.
        assert!(group_tags(&groups, "lego_fortnite").is_empty());
        assert!(group_tags(&groups, "creative").is_empty());
    }

    #[test]
    fn a_new_or_updated_fortnite_install_keeps_the_default_modes() {
        let groups = with_launcher_groups(
            "Fortnite",
            &fallback_groups("Fortnite").expect("Fortnite fallback data"),
        );
        let tags = expanded_tags(&groups, &[]);
        assert!(tags.iter().any(|tag| tag == "GFP_JunoRoot"));
        assert!(tags.iter().any(|tag| tag == "GFP_SaveTheWorldRoot"));
        assert!(tags.iter().any(|tag| tag == "FortniteBR"));
        // Nothing optional is preselected: quality assets stay a choice.
        assert!(!tags.iter().any(|tag| tag == "FortniteBREpicOptionalInstall"));
    }

    #[test]
    fn an_empty_fortnite_selection_still_keeps_the_modes() {
        let groups = with_launcher_groups(
            "Fortnite",
            &fallback_groups("Fortnite").expect("Fortnite fallback data"),
        );
        // The dialog sends the untagged tag when the user unchecks every extra.
        let tags = expanded_tags(&groups, &[String::new()]);
        assert!(tags.iter().any(|tag| tag == "GFP_JunoRoot"));
        assert!(tags.iter().any(|tag| tag == "GFP_SaveTheWorldRoot"));
        assert!(tags.iter().any(|tag| tag == "GFP_CreativeRoot"));
        assert!(tags.iter().any(|tag| tag == "FortniteBR"));
    }

    #[test]
    fn selecting_quality_assets_keeps_the_required_modes() {
        let groups = with_launcher_groups(
            "Fortnite",
            &fallback_groups("Fortnite").expect("Fortnite fallback data"),
        );
        let tags = expanded_tags(&groups, &["epic_assets".to_string()]);
        assert!(tags.iter().any(|tag| tag == "GFP_JunoRoot"));
        assert!(tags.iter().any(|tag| tag == "GFP_SaveTheWorldRoot"));
        assert!(tags.iter().any(|tag| tag == "FortniteBREpicOptionalInstall"));
    }

    #[test]
    fn launcher_groups_do_not_touch_other_games() {
        let groups = sample_groups();
        assert_eq!(with_launcher_groups("SomeOtherGame", &groups), groups);
    }
}
