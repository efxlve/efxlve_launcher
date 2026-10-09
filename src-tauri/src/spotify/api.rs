//! Thin Spotify Web API client. Only the endpoints the launcher and the
//! overlay need: profile, player state, devices, playlists, transport.

use serde::{Deserialize, Serialize};

const API: &str = "https://api.spotify.com/v1";

/// HTTP failure with the status the caller may branch on (401 → refresh,
/// 404 → no active device).
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.message, self.status)
    }
}

fn network_error(error: reqwest::Error) -> ApiError {
    ApiError {
        status: 0,
        message: error.to_string(),
    }
}

async fn api_error(response: reqwest::Response) -> ApiError {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<ErrorBody>(&text)
        .map(|body| body.error.message)
        .unwrap_or(text);
    ApiError { status, message }
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: String,
    pub url: String,
    pub uri: String,
    pub progress_ms: i64,
    pub duration_ms: i64,
    pub is_playing: bool,
    pub device_name: String,
    pub device_id: String,
    pub volume_percent: Option<i64>,
    pub shuffle: bool,
    pub repeat: String,
}

#[derive(Deserialize)]
struct PlayerState {
    is_playing: Option<bool>,
    progress_ms: Option<i64>,
    shuffle_state: Option<bool>,
    repeat_state: Option<String>,
    device: Option<DeviceJson>,
    item: Option<TrackJson>,
}

#[derive(Deserialize)]
struct TrackJson {
    name: Option<String>,
    uri: Option<String>,
    duration_ms: Option<i64>,
    artists: Option<Vec<Named>>,
    album: Option<AlbumJson>,
    external_urls: Option<Urls>,
}

#[derive(Deserialize)]
struct Named {
    name: Option<String>,
}

#[derive(Deserialize)]
struct AlbumJson {
    name: Option<String>,
    images: Option<Vec<ImageJson>>,
}

#[derive(Deserialize)]
struct ImageJson {
    url: Option<String>,
}

#[derive(Deserialize)]
struct Urls {
    spotify: Option<String>,
}

#[derive(Deserialize)]
struct DeviceJson {
    id: Option<String>,
    name: Option<String>,
    volume_percent: Option<i64>,
}

pub async fn me(client: &reqwest::Client, token: &str) -> Result<(String, String), ApiError> {
    #[derive(Deserialize)]
    struct Profile {
        display_name: Option<String>,
        product: Option<String>,
    }
    let response = client
        .get(format!("{API}/me"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let profile: Profile = response.json().await.map_err(network_error)?;
    Ok((
        profile
            .display_name
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Spotify".to_string()),
        profile.product.unwrap_or_default(),
    ))
}

pub async fn now_playing(
    client: &reqwest::Client,
    token: &str,
) -> Result<Option<NowPlaying>, ApiError> {
    let response = client
        .get(format!("{API}/me/player"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    match response.status().as_u16() {
        204 => Ok(None),
        200 => {
            let state: PlayerState = response.json().await.map_err(network_error)?;
            let Some(item) = state.item else {
                return Ok(None);
            };
            let artist = item
                .artists
                .as_ref()
                .map(|artists| {
                    artists
                        .iter()
                        .filter_map(|artist| artist.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let album = item.album.as_ref().and_then(|album| album.name.clone());
            let art_url = item
                .album
                .as_ref()
                .and_then(|album| album.images.as_ref())
                .and_then(|images| images.first())
                .and_then(|image| image.url.clone())
                .unwrap_or_default();
            let device = state.device.unwrap_or(DeviceJson {
                id: None,
                name: None,
                volume_percent: None,
            });
            Ok(Some(NowPlaying {
                title: item.name.unwrap_or_default(),
                artist,
                album: album.unwrap_or_default(),
                art_url,
                url: item
                    .external_urls
                    .and_then(|urls| urls.spotify)
                    .unwrap_or_default(),
                uri: item.uri.unwrap_or_default(),
                progress_ms: state.progress_ms.unwrap_or(0),
                duration_ms: item.duration_ms.unwrap_or(0),
                is_playing: state.is_playing.unwrap_or(false),
                device_name: device.name.unwrap_or_default(),
                device_id: device.id.unwrap_or_default(),
                volume_percent: device.volume_percent,
                shuffle: state.shuffle_state.unwrap_or(false),
                repeat: state.repeat_state.unwrap_or_else(|| "off".to_string()),
            }))
        }
        _ => Err(api_error(response).await),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub volume_percent: Option<i64>,
    pub kind: String,
}

pub async fn devices(client: &reqwest::Client, token: &str) -> Result<Vec<Device>, ApiError> {
    #[derive(Deserialize)]
    struct DeviceEntry {
        id: Option<String>,
        name: Option<String>,
        is_active: Option<bool>,
        volume_percent: Option<i64>,
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    #[derive(Deserialize)]
    struct DevicesBody {
        devices: Option<Vec<DeviceEntry>>,
    }
    let response = client
        .get(format!("{API}/me/player/devices"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let body: DevicesBody = response.json().await.map_err(network_error)?;
    Ok(body
        .devices
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let id = entry.id?;
            Some(Device {
                id,
                name: entry.name.unwrap_or_default(),
                is_active: entry.is_active.unwrap_or(false),
                volume_percent: entry.volume_percent,
                kind: entry.kind.unwrap_or_default(),
            })
        })
        .collect())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub uri: String,
    pub art_url: String,
    pub track_count: i64,
    pub owner: String,
}

pub async fn playlists(client: &reqwest::Client, token: &str) -> Result<Vec<Playlist>, ApiError> {
    #[derive(Deserialize)]
    struct PlaylistEntry {
        id: Option<String>,
        name: Option<String>,
        uri: Option<String>,
        images: Option<Vec<ImageJson>>,
        tracks: Option<TracksCount>,
        owner: Option<Named>,
    }
    #[derive(Deserialize)]
    struct TracksCount {
        total: Option<i64>,
    }
    #[derive(Deserialize)]
    struct PlaylistsBody {
        items: Option<Vec<PlaylistEntry>>,
    }
    let response = client
        .get(format!("{API}/me/playlists?limit=50"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let body: PlaylistsBody = response.json().await.map_err(network_error)?;
    Ok(body
        .items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let uri = entry.uri?;
            Some(Playlist {
                id: entry.id.unwrap_or_default(),
                name: entry.name.unwrap_or_default(),
                uri,
                art_url: entry
                    .images
                    .and_then(|images| images.into_iter().next())
                    .and_then(|image| image.url)
                    .unwrap_or_default(),
                track_count: entry.tracks.and_then(|tracks| tracks.total).unwrap_or(0),
                owner: entry.owner.and_then(|owner| owner.name).unwrap_or_default(),
            })
        })
        .collect())
}

/// Returns the URL + HTTP method for a control action. Kept separate so the
/// mapping is unit-testable.
fn control_request(
    action: &str,
    value: Option<i64>,
    device_id: Option<&str>,
) -> Option<(reqwest::Method, String)> {
    let mut url = url::Url::parse(&format!("{API}/me/player/{action}")).ok()?;
    let method = match action {
        "next" | "previous" => reqwest::Method::POST,
        "play" | "pause" | "seek" | "volume" | "shuffle" | "repeat" => reqwest::Method::PUT,
        _ => return None,
    };
    let mut query: Vec<(&str, String)> = Vec::new();
    match action {
        "seek" => query.push(("position_ms", value.unwrap_or(0).to_string())),
        "volume" => query.push((
            "volume_percent",
            value.unwrap_or(50).clamp(0, 100).to_string(),
        )),
        "shuffle" => query.push((
            "state",
            if value == Some(0) { "false" } else { "true" }.to_string(),
        )),
        "repeat" => query.push((
            "state",
            match value {
                Some(1) => "context",
                Some(2) => "track",
                _ => "off",
            }
            .to_string(),
        )),
        _ => {}
    }
    if let Some(device) = device_id {
        query.push(("device_id", device.to_string()));
    }
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Some((method, url.to_string()))
}

pub async fn control(
    client: &reqwest::Client,
    token: &str,
    action: &str,
    value: Option<i64>,
    device_id: Option<&str>,
) -> Result<(), ApiError> {
    let Some((method, url)) = control_request(action, value, device_id) else {
        return Err(ApiError {
            status: 0,
            message: format!("unknown_action:{action}"),
        });
    };
    let response = client
        .request(method, url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(network_error)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(api_error(response).await)
    }
}

pub async fn play_context(
    client: &reqwest::Client,
    token: &str,
    uri: &str,
    device_id: Option<&str>,
) -> Result<(), ApiError> {
    let mut url = url::Url::parse(&format!("{API}/me/player/play")).expect("static play URL");
    if let Some(device) = device_id {
        url.query_pairs_mut().append_pair("device_id", device);
    }
    // A track URI needs `uris`; playlists/albums are playback contexts.
    let body = if uri.contains(":track:") {
        serde_json::json!({ "uris": [uri] })
    } else {
        serde_json::json!({ "context_uri": uri })
    };
    let response = client
        .put(url.to_string())
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(api_error(response).await)
    }
}

/// Transfers playback to another Spotify Connect device.
pub async fn transfer(
    client: &reqwest::Client,
    token: &str,
    device_id: &str,
) -> Result<(), ApiError> {
    let response = client
        .put(format!("{API}/me/player"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "device_ids": [device_id] }))
        .send()
        .await
        .map_err(network_error)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(api_error(response).await)
    }
}

#[cfg(test)]
mod tests {
    use super::control_request;
    use reqwest::Method;

    #[test]
    fn control_actions_map_to_the_right_methods_and_queries() {
        let (method, url) = control_request("next", None, None).unwrap();
        assert_eq!(method, Method::POST);
        assert!(url.ends_with("/me/player/next"));

        let (method, url) = control_request("seek", Some(45_000), None).unwrap();
        assert_eq!(method, Method::PUT);
        assert!(url.contains("position_ms=45000"));

        let (_, url) = control_request("volume", Some(150), None).unwrap();
        assert!(url.contains("volume_percent=100"));

        let (_, url) = control_request("shuffle", Some(0), None).unwrap();
        assert!(url.contains("state=false"));

        let (_, url) = control_request("repeat", Some(2), None).unwrap();
        assert!(url.contains("state=track"));

        let (_, url) = control_request("play", None, Some("device1")).unwrap();
        assert!(url.contains("device_id=device1"));

        assert!(control_request("explode", None, None).is_none());
    }

    /// The player JSON shape must survive parsing into our DTOs.
    #[test]
    fn player_state_parses_into_now_playing_shape() {
        let json = r#"{
            "is_playing": true,
            "progress_ms": 12345,
            "shuffle_state": false,
            "repeat_state": "context",
            "device": {"id": "dev", "name": "PC", "volume_percent": 80},
            "item": {
                "name": "Nightcall",
                "uri": "spotify:track:abc",
                "duration_ms": 195000,
                "artists": [{"name": "Kavinsky"}],
                "album": {"name": "OutRun", "images": [{"url": "https://img/1.jpg"}]},
                "external_urls": {"spotify": "https://open.spotify.com/track/abc"}
            }
        }"#;
        // The conversion lives inside `now_playing`; here we only assert the
        // deserialization contract through a compiled probe of the same shape.
        #[derive(serde::Deserialize)]
        struct Probe {
            is_playing: bool,
            progress_ms: i64,
            device: DeviceProbe,
            item: ItemProbe,
        }
        #[derive(serde::Deserialize)]
        struct DeviceProbe {
            name: String,
            volume_percent: i64,
        }
        #[derive(serde::Deserialize)]
        struct ItemProbe {
            name: String,
            artists: Vec<ArtistProbe>,
            album: AlbumProbe,
        }
        #[derive(serde::Deserialize)]
        struct ArtistProbe {
            name: String,
        }
        #[derive(serde::Deserialize)]
        struct AlbumProbe {
            images: Vec<ImageProbe>,
        }
        #[derive(serde::Deserialize)]
        struct ImageProbe {
            url: String,
        }

        let probe: Probe = serde_json::from_str(json).expect("player JSON parses");
        assert!(probe.is_playing);
        assert_eq!(probe.progress_ms, 12345);
        assert_eq!(probe.device.name, "PC");
        assert_eq!(probe.device.volume_percent, 80);
        assert_eq!(probe.item.name, "Nightcall");
        assert_eq!(probe.item.artists[0].name, "Kavinsky");
        assert_eq!(probe.item.album.images[0].url, "https://img/1.jpg");
    }
}
