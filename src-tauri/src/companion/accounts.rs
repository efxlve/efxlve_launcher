//! Linked companion accounts.
//!
//! Linking records that the user asked this launcher to import the client on
//! this PC. Display names come from a single non-secret field. Passwords,
//! tickets and refresh tokens are never read.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::launch::client_installed;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAccount {
    pub store: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStoreStatus {
    pub store: String,
    pub client_installed: bool,
    pub account_name: String,
    pub linked: bool,
    pub game_count: u32,
}

pub(crate) fn accounts_file() -> PathBuf {
    data_dir().join("companion_accounts.json")
}

pub(crate) fn data_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".config")
        .join("efxlve")
}

pub(crate) fn load_accounts(path: &Path) -> Vec<CompanionAccount> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub(crate) fn save_accounts(path: &Path, accounts: &[CompanionAccount]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(accounts).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub(crate) fn is_store(store: &str) -> bool {
    matches!(store, "ea" | "ubisoft" | "xbox" | "battlenet")
}

/// Persona already signed in to the client, when the client stores one in a
/// plain field. Empty when the client is installed but has no display name.
pub(crate) fn detected_name(store: &str) -> String {
    match store {
        "ubisoft" => ubi_username(),
        "ea" => {
            if ea_profile_present() {
                "EA App".into()
            } else {
                String::new()
            }
        }
        "battlenet" => bnet_saved_name(),
        _ => String::new(),
    }
}

pub(crate) fn link_store(store: &str) -> Result<CompanionAccount, String> {
    if !is_store(store) {
        return Err("Unknown store".into());
    }
    if !client_installed(store) {
        return Err("@t:accounts.clientMissing".into());
    }
    let account = CompanionAccount {
        store: store.to_string(),
        name: detected_name(store),
    };
    let path = accounts_file();
    let mut accounts = load_accounts(&path);
    accounts.retain(|a| a.store != store);
    accounts.push(account.clone());
    save_accounts(&path, &accounts)?;
    Ok(account)
}

pub(crate) fn unlink_store(store: &str) -> Result<(), String> {
    let path = accounts_file();
    let mut accounts = load_accounts(&path);
    accounts.retain(|a| a.store != store);
    save_accounts(&path, &accounts)
}

/// `settings.yaml` account label. The password line under the same block is ignored.
pub(crate) fn masters_username(text: &str) -> Option<String> {
    let mut in_masters = false;
    let mut masters_indent = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if in_masters && indent <= masters_indent {
            in_masters = false;
        }
        if !in_masters && trimmed.starts_with("masters:") && indent == 0 {
            in_masters = true;
            masters_indent = indent;
            continue;
        }
        if !in_masters || indent <= masters_indent {
            continue;
        }
        if trimmed.starts_with("password:") {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("username:") {
            let name = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn ubi_username() -> String {
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return String::new();
    };
    let path = PathBuf::from(base).join("Ubisoft Game Launcher").join("settings.yaml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    if text.len() > 65_536 {
        return String::new();
    }
    masters_username(&text).unwrap_or_default()
}

fn ea_profile_present() -> bool {
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return false;
    };
    let dir = PathBuf::from(base).join("Electronic Arts").join("EA Desktop");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name.starts_with("user_") && name.ends_with(".ini")
    })
}

fn bnet_saved_name() -> String {
    let Some(base) = std::env::var_os("APPDATA") else {
        return String::new();
    };
    let path = PathBuf::from(base).join("Battle.net").join("Battle.net.config");
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    #[derive(Deserialize)]
    struct File {
        #[serde(rename = "Client")]
        client: Option<Client>,
    }
    #[derive(Deserialize)]
    struct Client {
        #[serde(rename = "SavedAccountNames")]
        saved: Option<String>,
    }
    let parsed: File = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    parsed
        .client
        .and_then(|c| c.saved)
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_is_read_and_the_password_is_not() {
        let text = "masters:\n  username: PlayerOne\n  password: hunter2\nuser:\n  offline: false\n";
        let name = masters_username(text);
        assert_eq!(name.as_deref(), Some("PlayerOne"));
        assert!(!format!("{name:?}").contains("hunter2"));
    }

    #[test]
    fn link_roundtrip_keeps_one_row_per_store() {
        let path = std::env::temp_dir().join(format!("efxlve-companion-acc-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut rows = vec![CompanionAccount { store: "ea".into(), name: "EA App".into() }];
        save_accounts(&path, &rows).unwrap();
        rows.retain(|a| a.store != "ea");
        rows.push(CompanionAccount { store: "ea".into(), name: "Other".into() });
        save_accounts(&path, &rows).unwrap();
        let loaded = load_accounts(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Other");
        let _ = std::fs::remove_file(&path);
    }
}
