//! GOG Account Switcher module.
//!
//! Stores and switches between multiple GOG user sessions by archiving
//! each account's data in `<app_data>/gog/accounts/<user_id>/`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedGogAccount {
    pub user_id: String,
    pub username: String,
    pub last_used: u64,
    pub is_active: bool,
    pub game_count: Option<usize>,
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn accounts_dir(gog_dir: &Path) -> PathBuf {
    gog_dir.join("accounts")
}

fn accounts_meta_file(gog_dir: &Path) -> PathBuf {
    accounts_dir(gog_dir).join("gog_accounts_meta.json")
}

const AUTH_JSON: &str = "auth.json";
const LIBRARY_SNAPSHOT: &str = "efxlve_gog_library_snapshot.json";
const ACHIEVEMENTS_CACHE: &str = "achievements_cache.json";

fn copy_if_file(src: &Path, dst: &Path) {
    if src.is_file() {
        let _ = fs::copy(src, dst);
    }
}

fn restore_or_remove(src: &Path, dst: &Path) {
    if src.is_file() {
        let _ = fs::copy(src, dst);
    } else if dst.is_file() {
        let _ = fs::remove_file(dst);
    }
}

/// Reads the current auth.json to extract the active user_id.
fn read_active_gog_user(gog_dir: &Path) -> Option<String> {
    let path = gog_dir.join(AUTH_JSON);
    let bytes = fs::read(&path).ok()?;
    // Auth is stored as {"46899977096215655": {"user_id": "...", ...}}
    if let Ok(map) = serde_json::from_slice::<std::collections::HashMap<String, serde_json::Value>>(&bytes) {
        for val in map.values() {
            if let Some(uid) = val.get("user_id").and_then(|v| v.as_str()) {
                if !uid.is_empty() {
                    return Some(uid.to_string());
                }
            }
        }
    }
    None
}

fn dedup_saved_accounts(list: &mut Vec<SavedGogAccount>) {
    const GOG_OAUTH_CLIENT_ID: &str = "46899977096215655";
    let mut seen = std::collections::HashSet::new();
    list.retain(|acc| {
        if acc.user_id.is_empty() || acc.user_id == GOG_OAUTH_CLIENT_ID {
            return false;
        }
        seen.insert(acc.user_id.clone())
    });
}

fn read_accounts_meta(gog_dir: &Path) -> Vec<SavedGogAccount> {
    let path = accounts_meta_file(gog_dir);
    if !path.is_file() {
        return Vec::new();
    }
    let mut list: Vec<SavedGogAccount> = fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default();
    dedup_saved_accounts(&mut list);
    list
}

fn write_accounts_meta(gog_dir: &Path, list: &[SavedGogAccount]) {
    let dir = accounts_dir(gog_dir);
    let _ = fs::create_dir_all(&dir);
    let path = accounts_meta_file(gog_dir);
    let mut unique = list.to_vec();
    dedup_saved_accounts(&mut unique);
    if let Ok(serialized) = serde_json::to_string_pretty(&unique) {
        let _ = fs::write(&path, serialized);
    }
}

fn archive_sidecars(gog_dir: &Path, acc_dir: &Path) {
    copy_if_file(&gog_dir.join(LIBRARY_SNAPSHOT), &acc_dir.join(LIBRARY_SNAPSHOT));
    copy_if_file(&gog_dir.join(ACHIEVEMENTS_CACHE), &acc_dir.join(ACHIEVEMENTS_CACHE));
}

/// Ensures the current active GOG user is saved in accounts/<user_id>/.
pub fn ensure_current_gog_account_saved(gog_dir: &Path, username: Option<&str>) {
    let Some(active_id) = read_active_gog_user(gog_dir) else {
        return;
    };

    let acc_dir = accounts_dir(gog_dir).join(&active_id);
    let _ = fs::create_dir_all(&acc_dir);

    // Copy auth.json
    copy_if_file(&gog_dir.join(AUTH_JSON), &acc_dir.join(AUTH_JSON));
    archive_sidecars(gog_dir, &acc_dir);

    // Update metadata
    let mut list = read_accounts_meta(gog_dir);
    let now = current_timestamp();
    let name = username.unwrap_or("GOG User").to_string();
    if let Some(existing) = list.iter_mut().find(|a| a.user_id == active_id) {
        if !name.is_empty() && name != "GOG User" {
            existing.username = name;
        }
        existing.last_used = now;
        existing.is_active = true;
    } else {
        list.push(SavedGogAccount {
            user_id: active_id.clone(),
            username: name,
            last_used: now,
            is_active: true,
            game_count: None,
        });
    }

    for acc in list.iter_mut() {
        acc.is_active = acc.user_id == active_id;
    }

    write_accounts_meta(gog_dir, &list);
}

/// Returns all saved GOG accounts, sorted by active first then last_used descending.
pub fn list_saved_gog_accounts(gog_dir: &Path, current_username: Option<&str>) -> Vec<SavedGogAccount> {
    ensure_current_gog_account_saved(gog_dir, current_username);

    let active_id = read_active_gog_user(gog_dir).unwrap_or_default();
    let mut list = read_accounts_meta(gog_dir);

    for acc in list.iter_mut() {
        acc.is_active = !active_id.is_empty() && acc.user_id == active_id;
    }

    list.sort_by(|a, b| {
        b.is_active.cmp(&a.is_active)
            .then_with(|| b.last_used.cmp(&a.last_used))
    });

    list
}

/// Switches the active GOG account to the target user_id.
pub fn switch_gog_account(gog_dir: &Path, target_user_id: &str, current_username: Option<&str>) -> Result<SavedGogAccount, String> {
    // 1. Save current
    ensure_current_gog_account_saved(gog_dir, current_username);

    // 2. Locate target
    let target_dir = accounts_dir(gog_dir).join(target_user_id);
    let target_auth = target_dir.join(AUTH_JSON);
    if !target_auth.is_file() {
        return Err(format!("Saved credentials for GOG account {} not found", target_user_id));
    }

    // 3. Restore target auth.json
    let _ = fs::copy(&target_auth, gog_dir.join(AUTH_JSON));

    // 4. Restore sidecars
    restore_or_remove(&target_dir.join(LIBRARY_SNAPSHOT), &gog_dir.join(LIBRARY_SNAPSHOT));
    restore_or_remove(&target_dir.join(ACHIEVEMENTS_CACHE), &gog_dir.join(ACHIEVEMENTS_CACHE));

    // 5. Update metadata
    let mut list = read_accounts_meta(gog_dir);
    let now = current_timestamp();
    let mut switched_acc: Option<SavedGogAccount> = None;

    for acc in list.iter_mut() {
        if acc.user_id == target_user_id {
            acc.last_used = now;
            acc.is_active = true;
            switched_acc = Some(acc.clone());
        } else {
            acc.is_active = false;
        }
    }

    write_accounts_meta(gog_dir, &list);
    switched_acc.ok_or_else(|| "GOG account not found in registry".to_string())
}

/// Removes a saved GOG account.
pub fn remove_saved_gog_account(gog_dir: &Path, target_user_id: &str) -> Result<(), String> {
    let target_dir = accounts_dir(gog_dir).join(target_user_id);
    if target_dir.is_dir() {
        let _ = fs::remove_dir_all(&target_dir);
    }

    let mut list = read_accounts_meta(gog_dir);
    list.retain(|a| a.user_id != target_user_id);
    write_accounts_meta(gog_dir, &list);

    // If removing the currently active user, remove auth.json too
    if let Some(active_id) = read_active_gog_user(gog_dir) {
        if active_id == target_user_id {
            let _ = fs::remove_file(gog_dir.join(AUTH_JSON));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gog_account_roundtrip() {
        let dir = std::env::temp_dir().join(format!("efxlve-test-gog-acc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Write a fake GOG auth.json
        let fake_auth = r#"{"46899977096215655": {"access_token": "test", "refresh_token": "test", "user_id": "gog_user_1"}}"#;
        fs::write(dir.join("auth.json"), fake_auth).unwrap();

        // List should auto-save
        let list = list_saved_gog_accounts(&dir, Some("TestGogUser"));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].user_id, "gog_user_1");
        assert_eq!(list[0].username, "TestGogUser");
        assert!(list[0].is_active);

        // Add second account
        let acc2_dir = dir.join("accounts").join("gog_user_2");
        fs::create_dir_all(&acc2_dir).unwrap();
        let fake_auth_2 = r#"{"46899977096215655": {"access_token": "test2", "refresh_token": "test2", "user_id": "gog_user_2"}}"#;
        fs::write(acc2_dir.join("auth.json"), fake_auth_2).unwrap();

        let mut meta = read_accounts_meta(&dir);
        meta.push(SavedGogAccount {
            user_id: "gog_user_2".into(),
            username: "SecondGogUser".into(),
            last_used: 100,
            is_active: false,
            game_count: None,
        });
        write_accounts_meta(&dir, &meta);

        // Switch to account 2
        let switched = switch_gog_account(&dir, "gog_user_2", Some("TestGogUser")).unwrap();
        assert_eq!(switched.user_id, "gog_user_2");

        // Remove account 1
        remove_saved_gog_account(&dir, "gog_user_1").unwrap();
        let list2 = list_saved_gog_accounts(&dir, Some("SecondGogUser"));
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].user_id, "gog_user_2");

        let _ = fs::remove_dir_all(&dir);
    }
}
