//! Read-only Epic friends list via Epic's public friends/account Web APIs.
//!
//! Uses the access token legendary already stores in `user.json`. The friends
//! summary endpoint only returns account ids, so display names and linked
//! platforms are resolved in a batched account lookup. These are unofficial
//! APIs and may change or be revoked at any time.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::skip::default_config_dir;

const FRIENDS_SUMMARY: &str =
    "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1";
const ACCOUNT_PUBLIC: &str =
    "https://account-public-service-prod.ol.epicgames.com/account/api/public/account";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicFriend {
    pub account_id: String,
    pub display_name: String,
    pub alias: String,
    pub favorite: bool,
    pub mutual: u32,
    pub platforms: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicFriendsData {
    pub account_id: String,
    pub display_name: String,
    pub friends: Vec<EpicFriend>,
}

#[derive(Debug, Deserialize)]
struct UserFile {
    #[serde(default)]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct SummaryFriend {
    #[serde(default, rename = "accountId")]
    account_id: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    mutual: u32,
}

#[derive(Debug, Default, Deserialize)]
struct Summary {
    #[serde(default)]
    friends: Vec<SummaryFriend>,
}

#[derive(Debug, Deserialize)]
struct Account {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default, rename = "externalAuths")]
    external_auths: Option<HashMap<String, serde_json::Value>>,
}

fn read_user(config: &Path) -> Result<UserFile, String> {
    let text = std::fs::read_to_string(config.join("user.json"))
        .map_err(|_| "@t:friends.notSignedIn".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Fetches the signed-in account's friends with resolved display names.
pub async fn fetch_friends() -> Result<EpicFriendsData, String> {
    let user = read_user(&default_config_dir())?;
    if user.account_id.is_empty() || user.access_token.is_empty() {
        return Err("@t:friends.notSignedIn".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let auth = format!("bearer {}", user.access_token);

    let resp = client
        .get(format!("{}/{}/summary", FRIENDS_SUMMARY, user.account_id))
        .header("Authorization", &auth)
        .send()
        .await
        .map_err(|_| "@t:friends.networkError".to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("@t:friends.authError".into());
    }
    let summary: Summary = resp
        .json()
        .await
        .map_err(|_| "@t:friends.networkError".to_string())?;

    // Resolve display names / linked platforms in batched account lookups.
    let ids: Vec<String> = summary
        .friends
        .iter()
        .map(|f| f.account_id.clone())
        .filter(|s| !s.is_empty())
        .collect();
    let mut accounts: HashMap<String, Account> = HashMap::new();
    for chunk in ids.chunks(40) {
        let mut req = client.get(ACCOUNT_PUBLIC).header("Authorization", &auth);
        for id in chunk {
            req = req.query(&[("accountId", id)]);
        }
        if let Ok(r) = req.send().await {
            if let Ok(list) = r.json::<Vec<Account>>().await {
                for a in list {
                    accounts.insert(a.id.clone(), a);
                }
            }
        }
    }

    let friends = merge_friends(summary.friends, accounts);

    Ok(EpicFriendsData {
        account_id: user.account_id,
        display_name: user.display_name,
        friends,
    })
}

/// Merges the friends summary with resolved account data and sorts the result
/// (favorites first, then alphabetically by display name).
fn merge_friends(
    friends: Vec<SummaryFriend>,
    mut accounts: HashMap<String, Account>,
) -> Vec<EpicFriend> {
    let mut out: Vec<EpicFriend> = friends
        .into_iter()
        .map(|f| {
            let acc = accounts.remove(&f.account_id);
            let display_name = acc
                .as_ref()
                .map(|a| a.display_name.clone())
                .unwrap_or_default();
            let mut platforms: Vec<String> = acc
                .as_ref()
                .and_then(|a| a.external_auths.as_ref())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            platforms.sort();
            EpicFriend {
                account_id: f.account_id,
                display_name,
                alias: f.alias,
                favorite: f.favorite,
                mutual: f.mutual,
                platforms,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.favorite.cmp(&a.favorite).then_with(|| {
            a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
        })
    });
    out
}

#[tauri::command]
pub async fn epic_friends() -> Result<EpicFriendsData, String> {
    fetch_friends().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, name: &str, auths: &[&str]) -> Account {
        let mut map = HashMap::new();
        for a in auths {
            map.insert((*a).to_string(), serde_json::json!({}));
        }
        Account {
            id: id.to_string(),
            display_name: name.to_string(),
            external_auths: Some(map),
        }
    }

    #[test]
    fn merges_names_platforms_and_orders_favorites_first() {
        let friends = vec![
            SummaryFriend {
                account_id: "b".into(),
                alias: "Burak".into(),
                favorite: false,
                mutual: 2,
            },
            SummaryFriend {
                account_id: "a".into(),
                alias: String::new(),
                favorite: true,
                mutual: 0,
            },
        ];
        let mut accounts = HashMap::new();
        accounts.insert("a".into(), account("a", "zeynep", &["psn"]));
        accounts.insert("b".into(), account("b", "ahmet", &["steam", "psn"]));

        let merged = merge_friends(friends, accounts);
        assert_eq!(merged.len(), 2);
        // Favorite first even though the display name sorts later.
        assert_eq!(merged[0].account_id, "a");
        assert_eq!(merged[0].display_name, "zeynep");
        assert_eq!(merged[0].platforms, vec!["psn"]);
        // Platforms are sorted alphabetically.
        assert_eq!(merged[1].platforms, vec!["psn", "steam"]);
        assert_eq!(merged[1].alias, "Burak");
    }

    #[test]
    fn missing_account_yields_empty_display_name() {
        let friends = vec![SummaryFriend {
            account_id: "x".into(),
            alias: "Alias".into(),
            favorite: false,
            mutual: 1,
        }];
        let merged = merge_friends(friends, HashMap::new());
        assert_eq!(merged[0].display_name, "");
        assert!(merged[0].platforms.is_empty());
    }
}
