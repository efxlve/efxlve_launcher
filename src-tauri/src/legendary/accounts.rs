//! Epic Games Account Switcher module.
//!
//! Stores and switches between multiple Epic Games user sessions by archiving
//! each account's `user.json` in `%USERPROFILE%\.config\legendary\accounts\<account_id>\`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedAccount {
    pub account_id: String,
    pub display_name: String,
    pub last_used: u64,
    pub is_active: bool,
    pub game_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserJsonMinimal {
    pub account_id: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn accounts_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("accounts")
}

fn accounts_meta_file(config_dir: &Path) -> PathBuf {
    accounts_dir(config_dir).join("accounts_meta.json")
}

/// Reads the currently active user.json in config_dir and returns (account_id, display_name).
pub fn read_active_user(config_dir: &Path) -> Option<(String, String)> {
    let user_path = config_dir.join("user.json");
    if !user_path.is_file() {
        return None;
    }
    let data = fs::read_to_string(&user_path).ok()?;
    let parsed: UserJsonMinimal = serde_json::from_str(&data).ok()?;
    match (parsed.account_id, parsed.display_name) {
        (Some(id), Some(name)) if !id.trim().is_empty() => Some((id.trim().to_string(), name.trim().to_string())),
        _ => None,
    }
}

/// Ensures the currently active user in config_dir/user.json is safely archived in accounts/<id>/.
pub fn ensure_current_account_saved(config_dir: &Path) {
    let Some((active_id, active_name)) = read_active_user(config_dir) else {
        return;
    };

    let acc_dir = accounts_dir(config_dir).join(&active_id);
    let _ = fs::create_dir_all(&acc_dir);

    // Copy user.json to accounts/<id>/user.json
    let src_user = config_dir.join("user.json");
    let dst_user = acc_dir.join("user.json");
    let _ = fs::copy(&src_user, &dst_user);

    // Also copy efxlve_library_snapshot.json if exists
    let src_snapshot = config_dir.join("efxlve_library_snapshot.json");
    if src_snapshot.is_file() {
        let _ = fs::copy(&src_snapshot, acc_dir.join("efxlve_library_snapshot.json"));
    }

    // Update metadata list
    let mut list = read_accounts_meta(config_dir);
    let now = current_timestamp();
    if let Some(existing) = list.iter_mut().find(|a| a.account_id == active_id) {
        existing.display_name = active_name.clone();
        existing.last_used = now;
        existing.is_active = true;
    } else {
        list.push(SavedAccount {
            account_id: active_id.clone(),
            display_name: active_name,
            last_used: now,
            is_active: true,
            game_count: None,
        });
    }

    // Set other accounts as not active
    for acc in list.iter_mut() {
        acc.is_active = acc.account_id == active_id;
    }

    write_accounts_meta(config_dir, &list);
}

fn read_accounts_meta(config_dir: &Path) -> Vec<SavedAccount> {
    let path = accounts_meta_file(config_dir);
    if !path.is_file() {
        return Vec::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn write_accounts_meta(config_dir: &Path, list: &[SavedAccount]) {
    let dir = accounts_dir(config_dir);
    let _ = fs::create_dir_all(&dir);
    let path = accounts_meta_file(config_dir);
    if let Ok(serialized) = serde_json::to_string_pretty(list) {
        let _ = fs::write(&path, serialized);
    }
}

/// Returns all saved accounts, ensuring current active user is included.
pub fn list_saved_accounts(config_dir: &Path) -> Vec<SavedAccount> {
    ensure_current_account_saved(config_dir);

    let active_id = read_active_user(config_dir).map(|(id, _)| id).unwrap_or_default();
    let mut list = read_accounts_meta(config_dir);

    for acc in list.iter_mut() {
        acc.is_active = !active_id.is_empty() && acc.account_id == active_id;
    }

    // Sort: active account first, then last_used descending
    list.sort_by(|a, b| {
        b.is_active.cmp(&a.is_active)
            .then_with(|| b.last_used.cmp(&a.last_used))
    });

    list
}

/// Switches the active account to target_account_id.
pub fn switch_account(config_dir: &Path, target_account_id: &str) -> Result<SavedAccount, String> {
    // 1. First save currently active user
    ensure_current_account_saved(config_dir);

    // 2. Locate target account folder
    let target_dir = accounts_dir(config_dir).join(target_account_id);
    let target_user = target_dir.join("user.json");
    if !target_user.is_file() {
        return Err(format!("Saved credentials for account {} not found", target_account_id));
    }

    // 3. Copy target user.json into active position
    let active_user = config_dir.join("user.json");
    fs::copy(&target_user, &active_user)
        .map_err(|e| format!("Failed to activate account user.json: {e}"))?;

    // 4. If target has a saved library snapshot, restore it; otherwise clear active snapshot
    let target_snapshot = target_dir.join("efxlve_library_snapshot.json");
    let active_snapshot = config_dir.join("efxlve_library_snapshot.json");
    if target_snapshot.is_file() {
        let _ = fs::copy(&target_snapshot, &active_snapshot);
    } else if active_snapshot.is_file() {
        let _ = fs::remove_file(&active_snapshot);
    }

    // 5. Update last_used in metadata
    let mut list = read_accounts_meta(config_dir);
    let now = current_timestamp();
    let mut switched_acc: Option<SavedAccount> = None;

    for acc in list.iter_mut() {
        if acc.account_id == target_account_id {
            acc.last_used = now;
            acc.is_active = true;
            switched_acc = Some(acc.clone());
        } else {
            acc.is_active = false;
        }
    }

    write_accounts_meta(config_dir, &list);

    switched_acc.ok_or_else(|| "Account not found in registry".to_string())
}

/// Removes a saved account from the switcher list.
pub fn remove_saved_account(config_dir: &Path, target_account_id: &str) -> Result<(), String> {
    let target_dir = accounts_dir(config_dir).join(target_account_id);
    if target_dir.is_dir() {
        let _ = fs::remove_dir_all(&target_dir);
    }

    let mut list = read_accounts_meta(config_dir);
    list.retain(|a| a.account_id != target_account_id);
    write_accounts_meta(config_dir, &list);

    // If removing the currently active user, remove active user.json as well
    if let Some((active_id, _)) = read_active_user(config_dir) {
        if active_id == target_account_id {
            let active_user = config_dir.join("user.json");
            let _ = fs::remove_file(&active_user);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_saved_account_roundtrip() {
        let dir = std::env::temp_dir().join(format!("efxlve-test-acc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Write a fake user.json
        let fake_user = r#"{"account_id": "test_acc_1", "displayName": "TesterOne"}"#;
        fs::write(dir.join("user.json"), fake_user).unwrap();

        // 1. List accounts should auto-save current
        let list = list_saved_accounts(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].account_id, "test_acc_1");
        assert_eq!(list[0].display_name, "TesterOne");
        assert!(list[0].is_active);

        // 2. Add second account manually to accounts/test_acc_2/user.json
        let acc2_dir = dir.join("accounts").join("test_acc_2");
        fs::create_dir_all(&acc2_dir).unwrap();
        let fake_user_2 = r#"{"account_id": "test_acc_2", "displayName": "TesterTwo"}"#;
        fs::write(acc2_dir.join("user.json"), fake_user_2).unwrap();

        let mut meta = read_accounts_meta(&dir);
        meta.push(SavedAccount {
            account_id: "test_acc_2".into(),
            display_name: "TesterTwo".into(),
            last_used: 100,
            is_active: false,
            game_count: None,
        });
        write_accounts_meta(&dir, &meta);

        // 3. Switch to account 2
        let switched = switch_account(&dir, "test_acc_2").unwrap();
        assert_eq!(switched.account_id, "test_acc_2");
        assert_eq!(switched.display_name, "TesterTwo");

        let active = read_active_user(&dir).unwrap();
        assert_eq!(active.0, "test_acc_2");
        assert_eq!(active.1, "TesterTwo");

        // 4. Remove account 1
        remove_saved_account(&dir, "test_acc_1").unwrap();
        let list2 = list_saved_accounts(&dir);
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].account_id, "test_acc_2");

        let _ = fs::remove_dir_all(&dir);
    }
}
