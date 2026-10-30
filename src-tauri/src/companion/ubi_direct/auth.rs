//! Exchange the stored web session for a ticket the Demux service accepts.
//!
//! The store sign-in already uses the same launcher app id as Demux, so the
//! stored ticket normally works as-is. Ubisoft can still scope a ticket to the
//! web surface; in that case this POST re-issues a session for the launcher app
//! using the ticket as the bearer (no password, no webview).

use crate::companion::ubisoft_login::Session;

const SESSIONS_URL: &str = "https://public-ubiservices.ubi.com/v3/profiles/sessions";
const DEMUX_APP_ID: &str = "f68a4bb5-608a-4ff2-8123-be8ef797e0a6";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) ConnectPC Safari/537.36";

/// Pull the ticket out of a session response. Kept separate so the wire shape is
/// testable without a network call.
fn ticket_from_body(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let ticket = value.get("ticket")?.as_str()?.trim();
    (!ticket.is_empty()).then(|| ticket.to_string())
}

pub(crate) async fn exchange_demux_ticket(session: &Session) -> Result<String, String> {
    if session.ticket.trim().is_empty() {
        return Err("no Ubisoft session ticket is stored".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("building the Ubisoft session client: {e}"))?;
    let response = client
        .post(SESSIONS_URL)
        .header("Content-Type", "application/json")
        .header("Ubi-AppId", DEMUX_APP_ID)
        .header("Ubi-RequestedPlatformType", "uplay")
        .header("Authorization", format!("ubi_v1 t={}", session.ticket))
        .json(&serde_json::json!({ "rememberMe": true }))
        .send()
        .await
        .map_err(|e| format!("exchanging the Ubisoft session: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("reading the Ubisoft session response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Ubisoft refused the ticket exchange ({status}): {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    ticket_from_body(&body)
        .ok_or_else(|| "Ubisoft returned no ticket from the session exchange".to_string())
}

#[cfg(test)]
mod tests {
    use super::ticket_from_body;

    #[test]
    fn reads_a_launcher_session_ticket() {
        let body = r#"{"ticket":"ubi_v1:abc","sessionId":"s","profileId":"p"}"#;
        assert_eq!(ticket_from_body(body).as_deref(), Some("ubi_v1:abc"));
    }

    #[test]
    fn rejects_an_empty_ticket() {
        assert_eq!(ticket_from_body(r#"{"ticket":"  "}"#), None);
        assert_eq!(ticket_from_body("not json"), None);
    }
}
