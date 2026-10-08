//! Music control for the overlay via Windows media sessions (SMTC).
//!
//! The Spotify Web API is no longer viable for third-party launchers, so the
//! overlay reads and controls whatever plays through the system media session:
//! Spotify desktop, browsers, any player. No OAuth, no account linking.

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// `Spotify.exe` and friends, with the extension trimmed.
    pub source: String,
    pub position_s: f64,
    pub duration_s: f64,
}

#[tauri::command]
pub async fn overlay_media_state() -> MediaState {
    tokio::task::spawn_blocking(state).await.unwrap_or_default()
}

#[tauri::command]
pub async fn overlay_media_control(action: String) -> bool {
    tokio::task::spawn_blocking(move || control(&action))
        .await
        .unwrap_or(false)
}

#[cfg(windows)]
fn state() -> MediaState {
    imp::state()
}

#[cfg(windows)]
fn control(action: &str) -> bool {
    imp::control(action)
}

#[cfg(not(windows))]
fn state() -> MediaState {
    MediaState::default()
}

#[cfg(not(windows))]
fn control(_action: &str) -> bool {
    false
}

#[cfg(windows)]
mod imp {
    use super::MediaState;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    fn current() -> Option<GlobalSystemMediaTransportControlsSession> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        manager.GetCurrentSession().ok()
    }

    pub fn state() -> MediaState {
        let Some(session) = current() else {
            return MediaState::default();
        };
        let props = session
            .TryGetMediaPropertiesAsync()
            .ok()
            .and_then(|op| op.get().ok());
        let (title, artist) = match props {
            Some(props) => (
                props.Title().map(|t| t.to_string()).unwrap_or_default(),
                props.Artist().map(|a| a.to_string()).unwrap_or_default(),
            ),
            None => (String::new(), String::new()),
        };
        let playing = session
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
            .unwrap_or(false);
        let (position_s, duration_s) = session
            .GetTimelineProperties()
            .ok()
            .map(|timeline| {
                (
                    timeline.Position().map(|p| p.Duration as f64 / 10_000_000.0).unwrap_or(0.0),
                    timeline.EndTime().map(|e| e.Duration as f64 / 10_000_000.0).unwrap_or(0.0),
                )
            })
            .unwrap_or((0.0, 0.0));
        let source = session
            .SourceAppUserModelId()
            .map(|id| id.to_string())
            .unwrap_or_default()
            .trim_end_matches(".exe")
            .to_string();
        MediaState {
            available: !title.is_empty(),
            title,
            artist,
            playing,
            source,
            position_s,
            duration_s,
        }
    }

    pub fn control(action: &str) -> bool {
        let Some(session) = current() else {
            return false;
        };
        let result = match action {
            "play" => session.TryPlayAsync(),
            "pause" => session.TryPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            _ => return false,
        };
        result.ok().and_then(|op| op.get().ok()).unwrap_or(false)
    }
}
