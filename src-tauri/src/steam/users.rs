//! The Steam account the client used most recently (`loginusers.vdf`).

use std::path::Path;

use super::vdf::{parse_vdf, Vdf};

/// SteamID64 + persona of the most recently used account (`loginusers.vdf`).
pub fn active_steam_user(steam: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(steam.join("config").join("loginusers.vdf")).ok()?;
    let root = parse_vdf(&text);
    let users = root.get("users")?;
    let mut fallback: Option<(String, String)> = None;
    for (id, node) in users.entries() {
        if !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let name = node
            .get("PersonaName")
            .and_then(Vdf::as_str)
            .unwrap_or("")
            .to_string();
        if fallback.is_none() {
            fallback = Some((id.clone(), name.clone()));
        }
        if node.get("MostRecent").and_then(Vdf::as_str) == Some("1") {
            return Some((id.clone(), name));
        }
    }
    fallback
}

/// SteamID64 of the most recently used account.
pub fn active_steam_id(steam: &Path) -> Option<String> {
    active_steam_user(steam).map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::super::vdf::{parse_vdf, Vdf};


    #[test]
    fn login_users_resolve_to_the_most_recent_persona() {
        let text = r#"
    "users"
    {
    	"76561199140017878"
    	{
    		"AccountName"		"efxlve"
    		"PersonaName"		"Efxlve"
    		"MostRecent"		"1"
    		"Timestamp"		"1700000000"
    	}
    	"76561198000000000"
    	{
    		"PersonaName"		"Other"
    		"MostRecent"		"0"
    	}
    }
    "#;
        let root = parse_vdf(text);
        let users = root.get("users").expect("users node");
        let mut persona = String::new();
        for (id, node) in users.entries() {
            if node.get("MostRecent").and_then(Vdf::as_str) == Some("1") {
                persona = format!(
                    "{id}:{}",
                    node.get("PersonaName").and_then(Vdf::as_str).unwrap_or("")
                );
            }
        }
        assert_eq!(persona, "76561199140017878:Efxlve");
    }
}
