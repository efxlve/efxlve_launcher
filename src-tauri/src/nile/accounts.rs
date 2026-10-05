//! Amazon multi-account switcher.
//!
//! Nile keeps one session inside its config dir: `current_user.json`, the
//! encrypted token file, `library.json` and `syncpoint.raw`. Each account's
//! session files are archived under `<app_data>/nile_accounts/<user_id>/`, and
//! switching copies them back into the live config dir. Installed games and
//! manifests stay shared because they belong to this PC, not to an account.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::cli;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedAmazonAccount {
    pub user_id: String,
    pub username: String,
    pub last_used: u64,
    pub is_active: bool,
    pub game_count: Option<usize>,
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Nile's live config dir (`<app_data>/nile`).
fn config_dir(root: &Path) -> PathBuf {
    root.join("nile")
}

/// Per-account session archive root (`<app_data>/nile_accounts`).
fn accounts_root(root: &Path) -> PathBuf {
    root.join("nile_accounts")
}

fn account_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !crate::vault_id::is_vault_id(id) {
        return Err("Invalid Amazon account id".to_string());
    }
    Ok(accounts_root(root).join(id))
}

fn meta_file(root: &Path) -> PathBuf {
    accounts_root(root).join("amazon_accounts_meta.json")
}

const USER_JSON: &str = "current_user.json";
const LIBRARY_JSON: &str = "library.json";
const SYNC_POINT: &str = "syncpoint.raw";

/// `current_user.json` of the live session: `(name, user_id)`.
pub fn read_current_user(root: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(config_dir(root).join(USER_JSON)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let user_id = value.get("user_id").and_then(|v| v.as_str())?.to_string();
    if user_id.is_empty() {
        return None;
    }
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some((name, user_id))
}

/// Every live session file: the user file, the encrypted token store(s), the
/// library snapshot and the sync marker.
fn session_files(config: &Path) -> Vec<PathBuf> {
    let mut out = vec![
        config.join(USER_JSON),
        config.join(LIBRARY_JSON),
        config.join(SYNC_POINT),
    ];
    if let Ok(entries) = fs::read_dir(config) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("enc") {
                out.push(path);
            }
        }
    }
    out
}

/// Drops the live session files (the machine state stays).
pub fn clear_live_session(config: &Path) {
    for path in session_files(config) {
        let _ = fs::remove_file(path);
    }
}

fn copy_session_files(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for path in session_files(from) {
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().ok_or("Bad session file name")?;
        fs::copy(&path, to.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn library_count(config: &Path) -> Option<usize> {
    let text = fs::read_to_string(config.join(LIBRARY_JSON)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(value.as_array()?.len())
}

fn read_meta(root: &Path) -> Vec<SavedAmazonAccount> {
    let path = meta_file(root);
    if !path.is_file() {
        return Vec::new();
    }
    let mut list: Vec<SavedAmazonAccount> = fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default();
    list.retain(|a| !a.user_id.is_empty());
    list
}

fn write_meta(root: &Path, list: &[SavedAmazonAccount]) {
    let dir = accounts_root(root);
    let _ = fs::create_dir_all(&dir);
    if let Ok(serialized) = serde_json::to_string_pretty(list) {
        let _ = fs::write(meta_file(root), serialized);
    }
}

/// Archives the live session of the signed-in account, creating or refreshing
/// its registry row. Returns the row when a session exists.
pub fn ensure_current_saved(root: &Path) -> Option<SavedAmazonAccount> {
    let (name, user_id) = read_current_user(root)?;
    let config = config_dir(root);
    let dir = account_dir(root, &user_id).ok()?;
    copy_session_files(&config, &dir).ok()?;

    let mut list = read_meta(root);
    let game_count = library_count(&config);
    let now = now_ts();
    if let Some(acc) = list.iter_mut().find(|a| a.user_id == user_id) {
        if !name.is_empty() {
            acc.username = name;
        }
        acc.last_used = now;
        if game_count.is_some() {
            acc.game_count = game_count;
        }
    } else {
        list.push(SavedAmazonAccount {
            user_id: user_id.clone(),
            username: if name.is_empty() {
                "Amazon Games".to_string()
            } else {
                name
            },
            last_used: now,
            is_active: true,
            game_count,
        });
    }
    for acc in list.iter_mut() {
        acc.is_active = acc.user_id == user_id;
    }
    write_meta(root, &list);
    list.into_iter().find(|a| a.user_id == user_id)
}

/// Saved accounts, active first, then most recently used.
pub fn list_saved_accounts(root: &Path) -> Vec<SavedAmazonAccount> {
    ensure_current_saved(root);
    let active = read_current_user(root).map(|(_, id)| id);
    let mut list = read_meta(root);
    for acc in list.iter_mut() {
        acc.is_active = active.as_deref() == Some(acc.user_id.as_str());
    }
    list.sort_by(|a, b| {
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| b.last_used.cmp(&a.last_used))
    });
    list
}

/// Restores one account's session into the live config dir.
pub fn switch_account(root: &Path, id: &str) -> Result<SavedAmazonAccount, String> {
    ensure_current_saved(root);
    let dir = account_dir(root, id)?;
    if !dir.join(USER_JSON).is_file() {
        return Err(format!("Saved Amazon session for {id} was not found"));
    }
    let config = config_dir(root);
    clear_live_session(&config);
    copy_session_files(&dir, &config)?;

    let mut list = read_meta(root);
    let now = now_ts();
    let mut switched = None;
    for acc in list.iter_mut() {
        if acc.user_id == id {
            acc.last_used = now;
            acc.is_active = true;
            switched = Some(acc.clone());
        } else {
            acc.is_active = false;
        }
    }
    write_meta(root, &list);
    switched.ok_or_else(|| "Amazon account not found in the registry".to_string())
}

/// Removes one account. Removing the active one signs it out and falls back to
/// the most recently used remaining account, if any.
pub fn remove_account(root: &Path, id: &str) -> Result<(), String> {
    let dir = account_dir(root, id)?;
    let active = read_current_user(root).map(|(_, uid)| uid);
    let _ = fs::remove_dir_all(&dir);

    let mut list = read_meta(root);
    list.retain(|a| a.user_id != id);
    write_meta(root, &list);

    if active.as_deref() == Some(id) {
        clear_live_session(&config_dir(root));
        if let Some(next) = list
            .iter()
            .max_by_key(|a| a.last_used)
            .map(|a| a.user_id.clone())
        {
            let _ = switch_account(root, &next);
        }
    }
    Ok(())
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn amazon_saved_accounts(app: AppHandle) -> Vec<SavedAmazonAccount> {
    list_saved_accounts(&cli::config_root(&app))
}

#[tauri::command]
pub fn amazon_switch_account(app: AppHandle, id: String) -> Result<SavedAmazonAccount, String> {
    switch_account(&cli::config_root(&app), &id)
}

#[tauri::command]
pub fn amazon_remove_saved_account(app: AppHandle, id: String) -> Result<(), String> {
    remove_account(&cli::config_root(&app), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(config: &Path, name: &str, user_id: &str, games: usize) {
        fs::create_dir_all(config).unwrap();
        fs::write(
            config.join(USER_JSON),
            format!(r#"{{"name": "{name}", "user_id": "{user_id}"}}"#),
        )
        .unwrap();
        fs::write(config.join("abcd1234.enc"), b"tokens").unwrap();
        let library: Vec<serde_json::Value> =
            (0..games).map(|i| serde_json::json!({ "id": i })).collect();
        fs::write(
            config.join(LIBRARY_JSON),
            serde_json::to_string(&library).unwrap(),
        )
        .unwrap();
        fs::write(config.join(SYNC_POINT), b"1").unwrap();
    }

    #[test]
    fn amazon_accounts_round_trip() {
        let root = std::env::temp_dir().join(format!("efxlve-test-amz-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let config = config_dir(&root);

        // Account one is live; listing archives it.
        write_session(&config, "First", "amzn1.account.ONE", 2);
        let list = list_saved_accounts(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].user_id, "amzn1.account.ONE");
        assert!(list[0].is_active);
        assert_eq!(list[0].game_count, Some(2));
        assert!(accounts_root(&root).join("amzn1.account.ONE").join("abcd1234.enc").is_file());

        // Account two logs in: the live files change and the archive follows.
        write_session(&config, "Second", "amzn1.account.TWO", 5);
        let list = list_saved_accounts(&root);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].user_id, "amzn1.account.TWO");

        // Switching back restores account one's session files.
        let switched = switch_account(&root, "amzn1.account.ONE").unwrap();
        assert_eq!(switched.username, "First");
        assert_eq!(read_current_user(&root).map(|(_, id)| id).as_deref(), Some("amzn1.account.ONE"));
        assert_eq!(library_count(&config), Some(2));

        // Removing the active account falls back to the remaining one.
        remove_account(&root, "amzn1.account.ONE").unwrap();
        let list = list_saved_accounts(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].user_id, "amzn1.account.TWO");
        assert!(list[0].is_active);
        assert_eq!(read_current_user(&root).map(|(_, id)| id).as_deref(), Some("amzn1.account.TWO"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_rejects_path_escape() {
        let root = std::env::temp_dir().join(format!("efxlve-test-amz-esc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(accounts_root(&root)).unwrap();
        let secret = root.join("secret.txt");
        fs::write(&secret, "keep").unwrap();

        assert!(remove_account(&root, r"..\secret.txt").is_err());
        assert!(switch_account(&root, "../secret.txt").is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "keep");

        let _ = fs::remove_dir_all(&root);
    }
}
