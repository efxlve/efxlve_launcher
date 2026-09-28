//! Read-only Epic friends list, friend requests and last-online presence via
//! Epic's public friends/presence Web APIs.
//!
//! Uses the access token legendary already stores in `user.json`. The friends
//! summary only returns account ids, so display names are resolved in a batched
//! account lookup. Last-online data comes from the presence service in a single
//! request for every friend. Friend actions (accept / ignore / remove) are plain
//! POST/DELETE calls on the same service. These are unofficial APIs and may
//! change or be revoked at any time.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::skip::default_config_dir;

const FRIENDS_SERVICE: &str =
    "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1";
const ACCOUNT_PUBLIC: &str =
    "https://account-public-service-prod.ol.epicgames.com/account/api/public/account";
const PRESENCE_SERVICE: &str =
    "https://presence-public-service-prod.ol.epicgames.com/presence/api/v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicFriend {
    pub account_id: String,
    pub display_name: String,
    pub alias: String,
    pub favorite: bool,
    pub mutual: u32,
    /// ISO timestamp of the last time this friend was seen online, if known.
    pub last_online: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicFriendRequest {
    pub account_id: String,
    pub display_name: String,
    pub mutual: u32,
    pub favorite: bool,
    pub created: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpicFriendsData {
    pub account_id: String,
    pub display_name: String,
    pub friends: Vec<EpicFriend>,
    pub incoming: Vec<EpicFriendRequest>,
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

#[derive(Debug, Default, Deserialize)]
struct SummaryFriend {
    #[serde(default, rename = "accountId")]
    account_id: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    mutual: u32,
    #[serde(default)]
    created: String,
}

#[derive(Debug, Default, Deserialize)]
struct Summary {
    #[serde(default)]
    friends: Vec<SummaryFriend>,
    #[serde(default)]
    incoming: Vec<SummaryFriend>,
}

#[derive(Debug, Deserialize)]
struct Account {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
}

fn read_user(config: &Path) -> Result<UserFile, String> {
    let text = std::fs::read_to_string(config.join("user.json"))
        .map_err(|_| "@t:friends.notSignedIn".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Reads the stored legendary session as `(account_id, access_token)`.
pub(crate) fn read_session() -> Result<(String, String), String> {
    let user = read_user(&default_config_dir())?;
    if user.account_id.is_empty() || user.access_token.is_empty() {
        return Err("@t:friends.notSignedIn".into());
    }
    Ok((user.account_id, user.access_token))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "@t:friends.networkError".to_string())
}

/// Fetches the signed-in account's friends, incoming requests and last-online data.
pub async fn fetch_friends() -> Result<EpicFriendsData, String> {
    let user = read_user(&default_config_dir())?;
    if user.account_id.is_empty() || user.access_token.is_empty() {
        return Err("@t:friends.notSignedIn".into());
    }

    let client = http_client()?;
    let auth = format!("bearer {}", user.access_token);
    let summary = fetch_summary(&client, &auth, &user.account_id).await?;

    // Resolve display names for friends and requests, and collect presence in
    // parallel: two roundtrips instead of one per friend.
    let ids: Vec<String> = {
        let mut seen = HashSet::new();
        summary
            .friends
            .iter()
            .chain(summary.incoming.iter())
            .map(|f| f.account_id.clone())
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect()
    };
    let (accounts, last_online) = tokio::join!(
        resolve_accounts(&client, &auth, &ids),
        fetch_last_online(&client, &auth, &user.account_id)
    );

    Ok(EpicFriendsData {
        account_id: user.account_id,
        display_name: user.display_name,
        friends: merge_friends(summary.friends, &accounts, &last_online),
        incoming: merge_requests(summary.incoming, &accounts),
    })
}

async fn fetch_summary(
    client: &reqwest::Client,
    auth: &str,
    account_id: &str,
) -> Result<Summary, String> {
    let resp = client
        .get(format!("{FRIENDS_SERVICE}/{account_id}/summary"))
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|_| "@t:friends.networkError".to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("@t:friends.authError".into());
    }
    if !status.is_success() {
        return Err("@t:friends.networkError".into());
    }
    resp.json::<Summary>()
        .await
        .map_err(|_| "@t:friends.networkError".to_string())
}

/// Batched account lookup for display names (best effort; names stay empty on failure).
async fn resolve_accounts(
    client: &reqwest::Client,
    auth: &str,
    ids: &[String],
) -> HashMap<String, Account> {
    let mut accounts: HashMap<String, Account> = HashMap::new();
    for chunk in ids.chunks(40) {
        let mut req = client.get(ACCOUNT_PUBLIC).header("Authorization", auth);
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
    accounts
}

/// Fetches per-friend last-online timestamps (best effort; empty map on failure).
async fn fetch_last_online(
    client: &reqwest::Client,
    auth: &str,
    account_id: &str,
) -> HashMap<String, String> {
    let resp = match client
        .get(format!("{PRESENCE_SERVICE}/_/{account_id}/last-online"))
        .header("Authorization", auth)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return HashMap::new(),
    };
    match resp.json::<serde_json::Value>().await {
        Ok(value) => parse_last_online(&value),
        Err(_) => HashMap::new(),
    }
}

/// The presence service answers with `{ "<accountId>": [{ "last_online": "..." }] }`.
fn parse_last_online(value: &serde_json::Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(map) = value.as_object() {
        for (id, entries) in map {
            if let Some(ts) = entries
                .as_array()
                .and_then(|a| a.first())
                .and_then(|e| e.get("last_online"))
                .and_then(|v| v.as_str())
            {
                out.insert(id.clone(), ts.to_string());
            }
        }
    }
    out
}

/// Merges the friends summary with resolved account data and last-online stamps,
/// then sorts the result (favorites first, then alphabetically by display name).
fn merge_friends(
    friends: Vec<SummaryFriend>,
    accounts: &HashMap<String, Account>,
    last_online: &HashMap<String, String>,
) -> Vec<EpicFriend> {
    let mut out: Vec<EpicFriend> = friends
        .into_iter()
        .map(|f| EpicFriend {
            display_name: accounts
                .get(&f.account_id)
                .map(|a| a.display_name.clone())
                .unwrap_or_default(),
            last_online: last_online.get(&f.account_id).cloned(),
            account_id: f.account_id,
            alias: f.alias,
            favorite: f.favorite,
            mutual: f.mutual,
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

/// Builds the incoming request list (oldest first so long-pending requests stay on top).
fn merge_requests(
    incoming: Vec<SummaryFriend>,
    accounts: &HashMap<String, Account>,
) -> Vec<EpicFriendRequest> {
    let mut out: Vec<EpicFriendRequest> = incoming
        .into_iter()
        .map(|f| EpicFriendRequest {
            display_name: accounts
                .get(&f.account_id)
                .map(|a| a.display_name.clone())
                .unwrap_or_default(),
            account_id: f.account_id,
            mutual: f.mutual,
            favorite: f.favorite,
            created: f.created,
        })
        .collect();
    out.sort_by(|a, b| a.created.cmp(&b.created));
    out
}

/// Accepts an incoming friend request. The friends service uses the same POST
/// route to send and to accept a request, so this also works without a pending one.
#[tauri::command]
pub async fn epic_friend_accept(friend_id: String) -> Result<(), String> {
    friend_action(&friend_id, reqwest::Method::POST).await
}

/// Removes a friend or ignores an incoming request (DELETE on the same route).
#[tauri::command]
pub async fn epic_friend_remove(friend_id: String) -> Result<(), String> {
    friend_action(&friend_id, reqwest::Method::DELETE).await
}

async fn friend_action(friend_id: &str, method: reqwest::Method) -> Result<(), String> {
    let user = read_user(&default_config_dir())?;
    if user.account_id.is_empty() || user.access_token.is_empty() {
        return Err("@t:friends.notSignedIn".into());
    }
    if friend_id.trim().is_empty() {
        return Err("@t:friends.actionFailed".into());
    }
    let client = http_client()?;
    let resp = client
        .request(
            method,
            format!("{FRIENDS_SERVICE}/{}/friends/{friend_id}", user.account_id),
        )
        .header("Authorization", format!("bearer {}", user.access_token))
        .send()
        .await
        .map_err(|_| "@t:friends.networkError".to_string())?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("@t:friends.authError".into());
    }
    Err("@t:friends.actionFailed".into())
}

#[tauri::command]
pub async fn epic_friends() -> Result<EpicFriendsData, String> {
    fetch_friends().await
}

/// Last-online timestamps for every friend (`{ "<accountId>": "<iso>" }`).
///
/// Kept separate from `epic_friends` so the friends page can refresh presence
/// with a single cheap request while it is open.
#[tauri::command]
pub async fn epic_friends_presence() -> Result<HashMap<String, String>, String> {
    let user = read_user(&default_config_dir())?;
    if user.account_id.is_empty() || user.access_token.is_empty() {
        return Err("@t:friends.notSignedIn".into());
    }
    let client = http_client()?;
    Ok(fetch_last_online(&client, &format!("bearer {}", user.access_token), &user.account_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, name: &str) -> Account {
        Account {
            id: id.to_string(),
            display_name: name.to_string(),
        }
    }

    fn summary_friend(id: &str, alias: &str, favorite: bool, mutual: u32) -> SummaryFriend {
        SummaryFriend {
            account_id: id.into(),
            alias: alias.into(),
            favorite,
            mutual,
            created: String::new(),
        }
    }

    #[test]
    fn merges_names_presence_and_orders_favorites_first() {
        let friends = vec![
            summary_friend("b", "Burak", false, 2),
            summary_friend("a", "", true, 0),
        ];
        let mut accounts = HashMap::new();
        accounts.insert("a".into(), account("a", "zeynep"));
        accounts.insert("b".into(), account("b", "ahmet"));
        let mut last_online = HashMap::new();
        last_online.insert("b".into(), "2026-09-27T18:30:22.915Z".to_string());

        let merged = merge_friends(friends, &accounts, &last_online);
        assert_eq!(merged.len(), 2);
        // Favorite first even though the display name sorts later.
        assert_eq!(merged[0].account_id, "a");
        assert_eq!(merged[0].display_name, "zeynep");
        assert_eq!(merged[0].last_online, None);
        assert_eq!(merged[1].alias, "Burak");
        assert_eq!(
            merged[1].last_online.as_deref(),
            Some("2026-09-27T18:30:22.915Z")
        );
    }

    #[test]
    fn missing_account_yields_empty_display_name() {
        let merged = merge_friends(
            vec![summary_friend("x", "Alias", false, 1)],
            &HashMap::new(),
            &HashMap::new(),
        );
        assert_eq!(merged[0].display_name, "");
        assert_eq!(merged[0].alias, "Alias");
    }

    #[test]
    fn parses_last_online_map() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{
                "abc": [{ "last_online": "2026-09-27T18:30:22.915Z" }],
                "def": [{ "last_online": "2026-01-02T03:04:05.000Z" }],
                "empty": [],
                "bad": "not-an-array"
            }"#,
        )
        .unwrap();
        let map = parse_last_online(&value);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("abc").map(String::as_str), Some("2026-09-27T18:30:22.915Z"));
        assert!(!map.contains_key("empty"));
        assert!(!map.contains_key("bad"));
    }

    #[test]
    fn incoming_requests_resolve_names_and_sort_oldest_first() {
        let mut new_req = summary_friend("n", "", false, 0);
        new_req.created = "2026-09-01T10:00:00.000Z".into();
        let mut old_req = summary_friend("o", "Old", false, 3);
        old_req.created = "2023-11-07T13:20:13.000Z".into();

        let mut accounts = HashMap::new();
        accounts.insert("n".into(), account("n", "Yeni"));
        accounts.insert("o".into(), account("o", "Eski"));

        let requests = merge_requests(vec![new_req, old_req], &accounts);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].account_id, "o");
        assert_eq!(requests[0].display_name, "Eski");
        assert_eq!(requests[0].mutual, 3);
        assert_eq!(requests[1].account_id, "n");
        assert_eq!(requests[1].display_name, "Yeni");
    }

    /// Live check against Epic's services using the session legendary stored.
    /// Requires a signed-in account; run with `cargo test -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_fetch_friends() {
        let data = fetch_friends().await.expect("fetch_friends");
        println!(
            "account={} friends={} incoming={}",
            data.display_name,
            data.friends.len(),
            data.incoming.len()
        );
        for f in data.friends.iter().take(5) {
            println!(
                "  friend {} ({}) last_online={:?}",
                f.display_name, f.account_id, f.last_online
            );
        }
        for r in data.incoming.iter().take(5) {
            println!("  incoming {} ({})", r.display_name, r.account_id);
        }
        assert!(!data.account_id.is_empty());
    }

    /// Live check of the friend action route with a bogus id: the service must
    /// answer 404 (path + auth correct), never 401/403.
    #[tokio::test]
    #[ignore]
    async fn live_friend_action_probe() {
        let missing = "00000000000000000000000000000000";
        let accept_err = friend_action(missing, reqwest::Method::POST).await;
        let remove_err = friend_action(missing, reqwest::Method::DELETE).await;
        println!("accept: {accept_err:?}");
        println!("remove: {remove_err:?}");
        assert!(accept_err.is_err() && remove_err.is_err());
    }

    /// Live end-to-end check of the write path: accepts the oldest incoming
    /// request, verifies it became a friend, then removes it again so the
    /// account state is restored.
    #[tokio::test]
    #[ignore]
    async fn live_friend_accept_and_remove() {
        let before = fetch_friends().await.expect("fetch_friends");
        let target = match before.incoming.last() {
            Some(r) => r.account_id.clone(),
            None => {
                println!("no incoming requests to test with");
                return;
            }
        };
        println!("target {} ({} incoming before)", target, before.incoming.len());

        friend_action(&target, reqwest::Method::POST)
            .await
            .expect("accept failed");
        let after_accept = fetch_friends().await.expect("fetch_friends");
        let became_friend = after_accept.friends.iter().any(|f| f.account_id == target);
        let still_incoming = after_accept.incoming.iter().any(|r| r.account_id == target);
        println!(
            "after accept: friends={} incoming={} became_friend={} still_incoming={}",
            after_accept.friends.len(),
            after_accept.incoming.len(),
            became_friend,
            still_incoming
        );

        friend_action(&target, reqwest::Method::DELETE)
            .await
            .expect("remove failed");
        let after_remove = fetch_friends().await.expect("fetch_friends");
        let still_friend = after_remove.friends.iter().any(|f| f.account_id == target);
        println!(
            "after remove: friends={} incoming={} still_friend={}",
            after_remove.friends.len(),
            after_remove.incoming.len(),
            still_friend
        );

        assert!(became_friend, "accepted request did not become a friend");
        assert!(!still_friend, "removed friend is still in the list");
    }
}
