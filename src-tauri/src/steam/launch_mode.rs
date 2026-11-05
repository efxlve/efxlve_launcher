//! Per-game Steam launch choices: which account signs in and whether the
//! client starts in offline mode.
//!
//! Steam keeps both in `config/loginusers.vdf`. The launcher never guesses:
//! it backs the file up, rewrites only the keys it owns, parses the result back
//! and restores the backup when verification fails. Changes are applied only
//! while the client is closed, because Steam rewrites the same file on exit.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::runtime::steam_install_path;
use super::vdf::{parse_vdf, Vdf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLaunchPref {
    /// SteamID64 to select, empty for the client's current account.
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub offline: bool,
}

impl SteamLaunchPref {
    fn is_default(&self) -> bool {
        self.account_id.trim().is_empty() && !self.offline
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLoginAccount {
    pub id: String,
    pub account_name: String,
    pub persona_name: String,
    pub most_recent: bool,
}

fn prefs_path(app: &AppHandle) -> PathBuf {    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam_launch_prefs.json")
}

fn read_prefs(app: &AppHandle) -> HashMap<String, SteamLaunchPref> {
    fs::read_to_string(prefs_path(app))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_prefs(app: &AppHandle, prefs: &HashMap<String, SteamLaunchPref>) -> Result<(), String> {
    let path = prefs_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_string_pretty(prefs).map_err(|error| error.to_string())?;
    fs::write(path, data).map_err(|error| error.to_string())
}

fn login_users_path() -> Result<PathBuf, String> {
    steam_install_path()
        .map(|steam| steam.join("config").join("loginusers.vdf"))
        .ok_or_else(|| "@t:steam.notInstalled".to_string())
}

fn valid_app_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.chars().all(|ch| ch.is_ascii_digit())
}

fn valid_account_id(value: &str) -> bool {
    value.is_empty() || (value.len() >= 5 && value.chars().all(|ch| ch.is_ascii_digit()))
}

/// The registry keeps the last auto-login account while Steam is closed; a
/// pid of 0 means the client is not running.
#[cfg(windows)]
fn steam_client_running() -> bool {
    let registry_pid = crate::winreg::query(
        r"HKCU\Software\Valve\Steam\ActiveProcess",
        Some("pid"),
    )
    .and_then(|output| {
        output
            .split_whitespace()
            .last()
            .map(|value| value.trim_start_matches("0x").to_string())
    })
    .and_then(|value| u32::from_str_radix(&value, 16).ok())
    .unwrap_or(0);
    if registry_pid != 0 {
        return true;
    }
    // The registry can be stale right after a crash; the process list is the
    // second opinion before loginusers.vdf is touched.
    let mut system = sysinfo::System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .values()
        .any(|process| process.name().eq_ignore_ascii_case("steam.exe"))
}

#[cfg(not(windows))]
fn steam_client_running() -> bool {
    false
}

fn accounts_from_text(text: &str) -> Vec<SteamLoginAccount> {
    let root = parse_vdf(text);
    let Some(users) = root.get("users") else {
        return Vec::new();
    };
    users
        .entries()
        .iter()
        .filter(|(id, _)| id.chars().all(|ch| ch.is_ascii_digit()))
        .map(|(id, node)| SteamLoginAccount {
            id: id.clone(),
            account_name: node
                .get("AccountName")
                .and_then(Vdf::as_str)
                .unwrap_or("")
                .to_string(),
            persona_name: node
                .get("PersonaName")
                .and_then(Vdf::as_str)
                .unwrap_or("")
                .to_string(),
            most_recent: node.get("MostRecent").and_then(Vdf::as_str) == Some("1"),
        })
        .collect()
}

#[tauri::command]
pub fn steam_login_accounts() -> Vec<SteamLoginAccount> {
    let Ok(path) = login_users_path() else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .map(|text| accounts_from_text(&text))
        .unwrap_or_default()
}

#[tauri::command]
pub fn steam_launch_prefs(app: AppHandle) -> HashMap<String, SteamLaunchPref> {
    read_prefs(&app)
}

/// Saves one game's choice. An empty account with offline off removes the
/// entry, so the client's own default stays the default.
#[tauri::command]
pub fn steam_set_launch_pref(
    app: AppHandle,
    app_id: String,
    account_id: String,
    offline: bool,
) -> Result<(), String> {
    if !valid_app_id(&app_id) {
        return Err("Invalid Steam app id".into());
    }
    let account_id = account_id.trim().to_string();
    if !valid_account_id(&account_id) {
        return Err("@t:steam.accountMissing".into());
    }
    if !account_id.is_empty() {
        let path = login_users_path()?;
        let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if !accounts_from_text(&text).iter().any(|account| account.id == account_id) {
            return Err("@t:steam.accountMissing".into());
        }
    }

    let mut prefs = read_prefs(&app);
    let next = SteamLaunchPref {
        account_id,
        offline,
    };
    if next.is_default() {
        prefs.remove(&app_id);
    } else {
        prefs.insert(app_id, next);
    }
    write_prefs(&app, &prefs)
}

fn brace_delta(line: &str) -> i32 {
    let mut in_quote = false;
    let mut escaped = false;
    let mut delta = 0;
    for ch in line.chars() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quote = false;
            }
        } else if ch == '"' {
            in_quote = true;
        } else if ch == '{' {
            delta += 1;
        } else if ch == '}' {
            delta -= 1;
        }
    }
    delta
}

fn quoted_user_id(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with('"') {
        return None;
    }
    let close = trimmed[1..].find('"')? + 1;
    let id = &trimmed[1..close];
    if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Replaces the quoted value that follows `"key"` on one VDF line.
fn replace_vdf_value(line: &str, key: &str, value: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let key_at = line.find(&marker)?;
    let after_key = key_at + marker.len();
    let open_rel = line[after_key..].find('"')?;
    let open = after_key + open_rel;
    let close_rel = line[open + 1..].find('"')?;
    let close = open + 1 + close_rel;
    let mut out = String::with_capacity(line.len() + value.len());
    out.push_str(&line[..open + 1]);
    out.push_str(value);
    out.push_str(&line[close..]);
    Some(out)
}

fn rewrite_block(lines: &mut Vec<String>, target: bool, offline: bool) {
    let mut seen: HashMap<&'static str, bool> = HashMap::new();
    for line in lines.iter_mut() {
        let trimmed = line.trim_start().to_string();
        for key in [
            "MostRecent",
            "AllowAutoLogin",
            "RememberPassword",
            "WantsOfflineMode",
            "SkipOfflineModeWarning",
        ] {
            if !trimmed.starts_with(&format!("\"{key}\"")) {
                continue;
            }
            let value = match key {
                "MostRecent" => if target { "1" } else { "0" },
                "WantsOfflineMode" | "SkipOfflineModeWarning" => {
                    if target && offline { "1" } else { "0" }
                }
                _ => "1",
            };
            if let Some(next) = replace_vdf_value(line, key, value) {
                *line = next;
                seen.insert(key, true);
            }
        }
    }
    if !target {
        return;
    }
    // Steam writes these keys already, but an older file may be short one.
    let insert_at = lines
        .iter()
        .rposition(|line| line.trim() == "}")
        .unwrap_or(lines.len().saturating_sub(1));
    let mut missing: Vec<&str> = Vec::new();
    for key in [
        "MostRecent",
        "AllowAutoLogin",
        "RememberPassword",
        "WantsOfflineMode",
        "SkipOfflineModeWarning",
    ] {
        if seen.get(key).copied().unwrap_or(false) {
            continue;
        }
        missing.push(key);
    }
    for (index, key) in missing.iter().enumerate() {
        let value = match *key {
            "WantsOfflineMode" | "SkipOfflineModeWarning" => {
                if offline { "1" } else { "0" }
            }
            _ => "1",
        };
        lines.insert(
            insert_at + index,
            format!("\t\t\t\"{key}\"\t\t\"{value}\""),
        );
    }
}

/// Rewrites one account's login flags. `target` is a SteamID64; `None` keeps
/// the current most-recent account. Exposed for tests.
fn rewrite_login_users(text: &str, target: Option<&str>, offline: bool) -> Result<String, String> {
    let root = parse_vdf(text);
    let users = root
        .get("users")
        .ok_or_else(|| "@t:steam.loginWriteFailed".to_string())?;
    let target_id = match target.map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => id.to_string(),
        None => users
            .entries()
            .iter()
            .find(|(_, node)| node.get("MostRecent").and_then(Vdf::as_str) == Some("1"))
            .map(|(id, _)| id.clone())
            .or_else(|| users.entries().first().map(|(id, _)| id.clone()))
            .ok_or_else(|| "@t:steam.accountMissing".to_string())?,
    };
    if !users.entries().iter().any(|(id, _)| id == &target_id) {
        return Err("@t:steam.accountMissing".to_string());
    }

    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 8);
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < lines.len() {
        let line = &lines[index];
        let line_depth = depth;
        if line_depth == 1 {
            if let Some(id) = quoted_user_id(line) {
                let mut open = index;
                let mut probe = index + 1;
                if !line.contains('{') {
                    while probe < lines.len() && lines[probe].trim().is_empty() {
                        probe += 1;
                    }
                    open = probe;
                }
                if open < lines.len() && lines[open].contains('{') {
                    let mut block_depth = 0i32;
                    let mut end = open;
                    while end < lines.len() {
                        block_depth += brace_delta(&lines[end]);
                        if block_depth == 0 && end >= open {
                            break;
                        }
                        end += 1;
                    }
                    if end < lines.len() {
                        let mut block: Vec<String> =
                            lines[index..=end].iter().cloned().collect();
                        rewrite_block(&mut block, id == target_id, offline);
                        out.extend(block);
                        // The whole block is consumed; the depth is back at 2.
                        index = end + 1;
                        continue;
                    }
                }
            }
        }
        depth += brace_delta(line);
        out.push(line.clone());
        index += 1;
    }

    let mut result = out.join(newline);
    if text.ends_with('\n') {
        result.push_str(newline);
    }
    Ok(result)
}

fn current_offline_flag(text: &str) -> bool {
    let root = parse_vdf(text);
    let Some(users) = root.get("users") else {
        return false;
    };
    users
        .entries()
        .iter()
        .find(|(_, node)| node.get("MostRecent").and_then(Vdf::as_str) == Some("1"))
        .and_then(|(_, node)| node.get("WantsOfflineMode").and_then(Vdf::as_str))
        == Some("1")
}

fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "loginusers.vdf".to_string());
    path.with_file_name(format!("{name}.efxlve-backup"))
}

/// Writes the rewritten file after a backup and verifies the parse on disk.
fn apply_login_mode(target: Option<&str>, offline: bool) -> Result<(), String> {
    let path = login_users_path()?;
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let rewritten = rewrite_login_users(&text, target, offline)?;
    if rewritten == text {
        return Ok(());
    }
    let backup = backup_path(&path);
    fs::copy(&path, &backup).map_err(|_| "@t:steam.backupFailed".to_string())?;
    fs::write(&path, &rewritten).map_err(|_| "@t:steam.loginWriteFailed".to_string())?;

    // Re-read and parse exactly what reached the disk.
    let check = fs::read_to_string(&path).map_err(|_| "@t:steam.loginVerifyFailed".to_string())?;
    let root = parse_vdf(&check);
    let target_id = target
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            root.get("users").and_then(|users| {
                users
                    .entries()
                    .iter()
                    .find(|(_, node)| {
                        node.get("MostRecent").and_then(Vdf::as_str) == Some("1")
                    })
                    .map(|(id, _)| id.clone())
            })
        });
    let verified = root
        .get("users")
        .zip(target_id.as_ref())
        .map(|(users, id)| {
            users.entries().iter().any(|(entry_id, node)| {
                entry_id == id
                    && node.get("MostRecent").and_then(Vdf::as_str) == Some("1")
                    && node.get("WantsOfflineMode").and_then(Vdf::as_str)
                        == Some(if offline { "1" } else { "0" })
            })
        })
        .unwrap_or(false);
    if !verified {
        let _ = fs::copy(&backup, &path);
        return Err("@t:steam.loginVerifyFailed".to_string());
    }

    // The registry makes the next client start pick the same account.
    #[cfg(windows)]
    {
        if let Some(name) = root.get("users").and_then(|users| {
            target_id.as_ref().and_then(|id| {
                users
                    .entries()
                    .iter()
                    .find(|(entry_id, _)| entry_id == id)
                    .and_then(|(_, node)| node.get("AccountName").and_then(Vdf::as_str))
            })
        }) {
            if !name.is_empty() {
                let _ = crate::winreg::set_string(
                    r"HKCU\Software\Valve\Steam",
                    "AutoLoginUser",
                    name,
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn steam_launch_game(app: AppHandle, app_id: String) -> Result<(), String> {
    if !valid_app_id(&app_id) {
        return Err("Invalid Steam app id".into());
    }
    let pref = read_prefs(&app).remove(&app_id).unwrap_or_default();
    let running = steam_client_running();

    #[cfg(not(windows))]
    if !pref.is_default() {
        return Err("@t:steam.launchModeWindowsOnly".to_string());
    }

    if pref.is_default() {
        // A previous offline run may have left the flag behind. Clear it only
        // when the client is closed; otherwise its in-memory state is truth.
        if !running {
            if let Ok(path) = login_users_path() {
                if let Ok(text) = fs::read_to_string(&path) {
                    if current_offline_flag(&text) {
                        let _ = apply_login_mode(None, false);
                    }
                }
            }
        }
        return super::protocol::steam_game_action(app_id, "launch".into());
    }

    if running {
        return Err("@t:steam.closeForLaunchMode".to_string());
    }
    let account = if pref.account_id.trim().is_empty() {
        None
    } else {
        Some(pref.account_id.trim())
    };
    apply_login_mode(account, pref.offline)?;

    #[cfg(windows)]
    {
        let steam = steam_install_path().ok_or_else(|| "@t:steam.notInstalled".to_string())?;
        let exe = steam.join("steam.exe");
        let mut command = Command::new(&exe);
        command
            .args(["-silent", "-applaunch", &app_id])
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Steam could not be opened: {error}"))
    }
    #[cfg(not(windows))]
    {
        Err("@t:steam.launchModeWindowsOnly".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#""users"
{
	"76561199140017878"
	{
		"AccountName"		"efxlve"
		"PersonaName"		"Efxlve"
		"RememberPassword"		"1"
		"WantsOfflineMode"		"0"
		"SkipOfflineModeWarning"		"0"
		"AllowAutoLogin"		"1"
		"MostRecent"		"1"
		"Timestamp"		"1700000000"
	}
	"76561198000000000"
	{
		"AccountName"		"other"
		"PersonaName"		"Other"
		"RememberPassword"		"1"
		"WantsOfflineMode"		"0"
		"SkipOfflineModeWarning"		"0"
		"AllowAutoLogin"		"1"
		"MostRecent"		"0"
		"Timestamp"		"1600000000"
	}
}
"#;

    #[test]
    fn switches_the_most_recent_account_and_sets_offline_flags() {
        let rewritten = rewrite_login_users(SAMPLE, Some("76561198000000000"), true).unwrap();
        let root = parse_vdf(&rewritten);
        let users = root.get("users").unwrap();
        let target = users.get("76561198000000000").unwrap();
        assert_eq!(target.get("MostRecent").and_then(Vdf::as_str), Some("1"));
        assert_eq!(target.get("WantsOfflineMode").and_then(Vdf::as_str), Some("1"));
        assert_eq!(
            target.get("SkipOfflineModeWarning").and_then(Vdf::as_str),
            Some("1")
        );
        assert_eq!(
            users
                .get("76561199140017878")
                .unwrap()
                .get("MostRecent")
                .and_then(Vdf::as_str),
            Some("0")
        );
        // Unknown keys survive the rewrite.
        assert_eq!(
            target.get("Timestamp").and_then(Vdf::as_str),
            Some("1600000000")
        );
        assert!(accounts_from_text(&rewritten)
            .iter()
            .any(|account| account.id == "76561198000000000" && account.most_recent));
    }

    #[test]
    fn clearing_offline_returns_the_account_to_online() {
        let offline = rewrite_login_users(SAMPLE, None, true).unwrap();
        let online = rewrite_login_users(&offline, None, false).unwrap();
        let root = parse_vdf(&online);
        let current = root
            .get("users")
            .unwrap()
            .get("76561199140017878")
            .unwrap();
        assert_eq!(current.get("WantsOfflineMode").and_then(Vdf::as_str), Some("0"));
        assert_eq!(
            current.get("SkipOfflineModeWarning").and_then(Vdf::as_str),
            Some("0")
        );
    }

    #[test]
    fn an_unknown_account_is_rejected() {
        assert_eq!(
            rewrite_login_users(SAMPLE, Some("76561190000000000"), true).unwrap_err(),
            "@t:steam.accountMissing"
        );
    }

    #[test]
    fn missing_flags_are_inserted_before_the_block_closes() {
        let minimal = r#""users"
{
	"76561199140017878"
	{
		"AccountName"		"efxlve"
		"PersonaName"		"Efxlve"
		"MostRecent"		"1"
	}
}
"#;
        let rewritten = rewrite_login_users(minimal, None, true).unwrap();
        let root = parse_vdf(&rewritten);
        let node = root
            .get("users")
            .unwrap()
            .get("76561199140017878")
            .unwrap();
        assert_eq!(node.get("WantsOfflineMode").and_then(Vdf::as_str), Some("1"));
        assert_eq!(
            node.get("SkipOfflineModeWarning").and_then(Vdf::as_str),
            Some("1")
        );
        assert_eq!(node.get("AllowAutoLogin").and_then(Vdf::as_str), Some("1"));
    }

    #[test]
    fn the_current_offline_flag_reads_the_most_recent_account() {
        assert!(!current_offline_flag(SAMPLE));
        let offline = rewrite_login_users(SAMPLE, None, true).unwrap();
        assert!(current_offline_flag(&offline));
    }
}
