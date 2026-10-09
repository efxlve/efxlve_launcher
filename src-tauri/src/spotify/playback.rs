//! In-launcher Spotify playback: the launcher itself becomes a Spotify
//! Connect receiver through librespot — the same model spotifast, spotifyd and
//! spotify-player use.
//!
//! Pairing is one browser approval against Spotify's own desktop client
//! (`streaming` scope only, no developer app needed). After that the launcher
//! shows up as "Efxlve Launcher" in every Spotify client, and the overlay
//! controls it straight through the in-process handle — no Spotify Web API
//! session, no developer app anywhere in the app.
//!
//! The player event stream feeds the overlay's now-playing card (title,
//! artists, cover, position, volume, shuffle, repeat), so the card works
//! without any network round-trip of its own.
//!
//! Spotify requires Premium for librespot playback.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Name shown in every Spotify client's device picker.
const DEVICE_NAME: &str = "Efxlve Launcher";

/// Loopback redirect registered for Spotify's own desktop client; librespot's
/// OAuth helper binds it and shows the approval page in the browser.
#[cfg(windows)]
const REDIRECT_URI: &str = "http://127.0.0.1:8898/login";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    /// The one-time browser approval is stored.
    pub paired: bool,
    /// The Connect receiver is running right now.
    pub running: bool,
    pub device_name: String,
}

/// The current track, in the shape the overlay player expects.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackNow {
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
    pub volume_percent: i64,
    pub shuffle: bool,
    /// "off" | "context" | "track"
    pub repeat: String,
}

/// One entry of the user's playlist rootlist, for the overlay picker.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub uri: String,
    pub name: String,
    pub track_count: i64,
    pub art_url: String,
}

/// One track row of a playlist, for the overlay browser.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackSummary {
    pub uri: String,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    pub art_url: String,
}

/// Tokens from the playback approval.
#[derive(Serialize, Deserialize, Clone)]
pub struct PlaybackToken {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Sending `()` stops the engine thread.
static STOP: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

fn token_path(app: &AppHandle) -> PathBuf {
    crate::spotify::data_dir(app).join("playback.json")
}

fn load_token(app: &AppHandle) -> Option<PlaybackToken> {
    let text = std::fs::read_to_string(token_path(app)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_token(app: &AppHandle, token: &PlaybackToken) {
    if let Ok(text) = serde_json::to_string(token) {
        let _ = std::fs::write(token_path(app), text);
    }
}

fn clear_token(app: &AppHandle) {
    let _ = std::fs::remove_file(token_path(app));
}

pub fn status(app: &AppHandle) -> PlaybackStatus {
    PlaybackStatus {
        paired: load_token(app).is_some(),
        running: RUNNING.load(Ordering::Relaxed),
        device_name: DEVICE_NAME.to_string(),
    }
}

/// Stops the receiver; called when the app exits.
pub fn stop() {
    if let Ok(mut slot) = STOP.lock() {
        if let Some(stop) = slot.take() {
            let _ = stop.send(());
        }
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn spotify_playback_status(app: AppHandle) -> PlaybackStatus {
    status(&app)
}

/// Starts the Connect receiver. When no playback approval is stored yet this
/// opens the browser and waits for the user; the UI shows a waiting state.
#[tauri::command]
pub async fn spotify_playback_start(app: AppHandle) -> Result<PlaybackStatus, String> {
    #[cfg(windows)]
    {
        let handle = tauri::async_runtime::spawn_blocking(move || imp::start(app));
        handle.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("unsupported".to_string())
    }
}

/// The track the receiver is on right now; `None` before the first track.
#[tauri::command]
pub fn spotify_playback_now() -> Option<PlaybackNow> {
    #[cfg(windows)]
    {
        imp::now()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Transport and mode control straight on the local receiver. `action` is one
/// of: play, pause, next, previous, seek, volume, shuffle, repeat.
#[tauri::command]
pub fn spotify_playback_control(action: String, value: Option<i64>) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::control(&action, value)
    }
    #[cfg(not(windows))]
    {
        let _ = (action, value);
        Err("unsupported".to_string())
    }
}

/// The user's playlists, for the overlay picker (cached for a few minutes).
#[tauri::command]
pub async fn spotify_playback_playlists(force: Option<bool>) -> Result<Vec<PlaylistSummary>, String> {
    #[cfg(windows)]
    {
        imp::playlists(force.unwrap_or(false)).await
    }
    #[cfg(not(windows))]
    {
        let _ = force;
        Err("unsupported".to_string())
    }
}

/// The tracks of one playlist, for the overlay browser.
#[tauri::command]
pub async fn spotify_playback_playlist_tracks(uri: String) -> Result<Vec<TrackSummary>, String> {
    #[cfg(windows)]
    {
        imp::playlist_tracks(&uri).await
    }
    #[cfg(not(windows))]
    {
        let _ = uri;
        Err("unsupported".to_string())
    }
}

/// Loads and starts a playlist context on the local receiver, optionally
/// starting at one specific track.
#[tauri::command]
pub fn spotify_playback_play(uri: String, track_uri: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::play(&uri, track_uri.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = (uri, track_uri);
        Err("unsupported".to_string())
    }
}

/// "off" / "context" / "track" from the two Connect repeat flags.
fn repeat_label(context: bool, track: bool) -> &'static str {
    if track {
        "track"
    } else if context {
        "context"
    } else {
        "off"
    }
}

/// Volume percent (0..100) from the u16 mixer scale, rounded to nearest.
fn raw_to_percent(raw: u16) -> i64 {
    ((raw as u32 * 100 + u16::MAX as u32 / 2) / u16::MAX as u32) as i64
}

/// u16 mixer volume from a 0..100 percent, rounded to nearest.
fn percent_to_raw(percent: i64) -> u16 {
    ((percent.clamp(0, 100) as u32 * u16::MAX as u32 + 50) / 100) as u16
}

/// `spotify:track:<id>` -> `https://open.spotify.com/track/<id>`.
fn web_url(uri: &str) -> String {
    match uri.strip_prefix("spotify:") {
        Some(rest) => format!("https://open.spotify.com/{}", rest.replace(':', "/")),
        None => String::new(),
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use librespot::connect::{ConnectConfig, LoadRequest, LoadRequestOptions, PlayingTrack, Spirc};
    use librespot::core::{
        authentication::Credentials, cache::Cache, config::DeviceType, config::SessionConfig,
        session::Session, FileId, SpotifyUri,
    };
    use librespot::metadata::audio::{AudioItem, UniqueFields};
    use librespot::metadata::playlist::list::SelectedListContent as RootlistContent;
    use librespot::metadata::{Metadata, Playlist};
    use librespot::oauth::{OAuthClientBuilder, OAuthToken};
    use librespot::playback::{
        audio_backend,
        config::{AudioFormat, PlayerConfig},
        mixer::{self, MixerConfig},
        player::{Player, PlayerEvent, PlayerEventChannel},
    };
    use librespot::protocol::playlist4_external::SelectedListContent as RootlistMessage;
    use protobuf::Message as _;
    use std::sync::mpsc::{Receiver, Sender};
    use std::sync::Arc;

    /// Small bilingual landing page shown in the browser after approval.
    const CALLBACK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Efxlve Launcher</title><style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;max-width:420px}h1{font-size:18px}p{color:#9aa0ab;font-size:14px}</style></head><body><div><h1>Çalma etkinleştirildi / Playback enabled</h1><p>Bu sekmeyi kapatıp Efxlve Launcher'a dönebilirsin.<br>You can close this tab and return to Efxlve Launcher.</p></div></body></html>";

    /// Live transport state, fed by the player event stream.
    struct NowState {
        item: Option<AudioItem>,
        position_ms: u32,
        /// When `position_ms` was last known; playing time since is added.
        updated_at: Option<Instant>,
        playing: bool,
        volume: u16,
        shuffle: bool,
        repeat_context: bool,
        repeat_track: bool,
    }

    impl Default for NowState {
        fn default() -> Self {
            Self {
                item: None,
                position_ms: 0,
                updated_at: None,
                playing: false,
                volume: u16::MAX / 2,
                shuffle: false,
                repeat_context: false,
                repeat_track: false,
            }
        }
    }

    impl NowState {
        fn position_now(&self) -> u32 {
            let elapsed = if self.playing {
                self.updated_at
                    .map(|at| at.elapsed().as_millis() as u32)
                    .unwrap_or(0)
            } else {
                0
            };
            self.position_ms.saturating_add(elapsed)
        }
    }

    static SPIRC: Mutex<Option<Arc<Spirc>>> = Mutex::new(None);
    static NOW: Mutex<Option<NowState>> = Mutex::new(None);
    /// The engine's session, kept for playlist browsing.
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    /// Rootlist cache: the picker refetches at most every few minutes.
    static PLAYLISTS: Mutex<Option<(Instant, Vec<PlaylistSummary>)>> = Mutex::new(None);
    const PLAYLISTS_TTL: Duration = Duration::from_secs(300);
    /// Track list of the playlist currently open in the browser.
    static TRACKS: Mutex<Option<(Instant, String, Vec<TrackSummary>)>> = Mutex::new(None);
    const TRACKS_TTL: Duration = Duration::from_secs(600);
    const TRACK_LIMIT: usize = 60;

    fn update(change: impl FnOnce(&mut NowState)) {
        if let Ok(mut guard) = NOW.lock() {
            if let Some(state) = guard.as_mut() {
                change(state);
            }
        }
    }

    fn artists_of(item: &AudioItem) -> String {
        match &item.unique_fields {
            UniqueFields::Track { artists, .. } => artists
                .0
                .iter()
                .map(|artist| artist.name.clone())
                .collect::<Vec<_>>()
                .join(", "),
            UniqueFields::Episode { show_name, .. } => show_name.clone(),
            UniqueFields::Local { artists, .. } => artists.clone().unwrap_or_default(),
        }
    }

    fn album_of(item: &AudioItem) -> String {
        match &item.unique_fields {
            UniqueFields::Track { album, .. } => album.clone(),
            UniqueFields::Episode { .. } => String::new(),
            UniqueFields::Local { album, .. } => album.clone().unwrap_or_default(),
        }
    }

    pub fn now() -> Option<PlaybackNow> {
        let guard = NOW.lock().ok()?;
        let state = guard.as_ref()?;
        let item = state.item.as_ref()?;
        Some(PlaybackNow {
            title: item.name.clone(),
            artist: artists_of(item),
            album: album_of(item),
            art_url: item
                .covers
                .first()
                .map(|cover| cover.url.clone())
                .unwrap_or_default(),
            url: web_url(&item.uri),
            uri: item.uri.clone(),
            progress_ms: state.position_now().min(item.duration_ms) as i64,
            duration_ms: item.duration_ms as i64,
            is_playing: state.playing,
            device_name: DEVICE_NAME.to_string(),
            device_id: String::new(),
            volume_percent: raw_to_percent(state.volume),
            shuffle: state.shuffle,
            repeat: repeat_label(state.repeat_context, state.repeat_track).to_string(),
        })
    }

    pub fn control(action: &str, value: Option<i64>) -> Result<(), String> {
        let spirc = SPIRC
            .lock()
            .map_err(|_| "state_poisoned".to_string())?
            .clone()
            .ok_or_else(|| "not_running".to_string())?;

        let result = match action {
            "play" => {
                let result = spirc.play();
                if result.is_ok() {
                    update(|state| {
                        state.playing = true;
                        state.updated_at = Some(Instant::now());
                    });
                }
                result
            }
            "pause" => {
                let result = spirc.pause();
                if result.is_ok() {
                    update(|state| {
                        state.playing = false;
                        state.updated_at = Some(Instant::now());
                    });
                }
                result
            }
            "next" => spirc.next(),
            "previous" => spirc.prev(),
            "seek" => {
                let position = value.unwrap_or(0).clamp(0, u32::MAX as i64) as u32;
                let result = spirc.set_position_ms(position);
                if result.is_ok() {
                    update(|state| {
                        state.position_ms = position;
                        state.updated_at = Some(Instant::now());
                    });
                }
                result
            }
            "volume" => {
                let raw = percent_to_raw(value.unwrap_or(50));
                let result = spirc.set_volume(raw);
                if result.is_ok() {
                    update(|state| state.volume = raw);
                }
                result
            }
            "shuffle" => {
                let shuffle = value.unwrap_or(0) != 0;
                let result = spirc.shuffle(shuffle);
                if result.is_ok() {
                    update(|state| state.shuffle = shuffle);
                }
                result
            }
            "repeat" => {
                let (context, track) = match value.unwrap_or(0) {
                    2 => (true, true),
                    1 => (true, false),
                    _ => (false, false),
                };
                let result = spirc.repeat(context).and_then(|_| spirc.repeat_track(track));
                if result.is_ok() {
                    update(|state| {
                        state.repeat_context = context;
                        state.repeat_track = track;
                    });
                }
                result
            }
            _ => return Err(format!("unknown_action:{action}")),
        };
        result.map_err(|error| error.to_string())
    }

    /// The user's playlists: rootlist first, then one metadata fetch per entry
    /// (in parallel). Cached, so the picker opens instantly after the first
    /// load.
    pub async fn playlists(force: bool) -> Result<Vec<PlaylistSummary>, String> {
        if !force {
            if let Ok(guard) = PLAYLISTS.lock() {
                if let Some((at, cached)) = guard.as_ref() {
                    if at.elapsed() < PLAYLISTS_TTL {
                        return Ok(cached.clone());
                    }
                }
            }
        }

        let session = SESSION
            .lock()
            .map_err(|_| "state_poisoned".to_string())?
            .clone()
            .ok_or_else(|| "not_running".to_string())?;

        let bytes = session
            .spclient()
            .get_rootlist(0, Some(60))
            .await
            .map_err(|error| error.to_string())?;
        let message = RootlistMessage::parse_from_bytes(&bytes).map_err(|error| error.to_string())?;
        let content = RootlistContent::try_from(&message).map_err(|error| error.to_string())?;

        let mut tasks = tokio::task::JoinSet::new();
        for item in content.contents.items.iter() {
            if !matches!(item.id, SpotifyUri::Playlist { .. }) {
                continue;
            }
            let uri = item.id.clone();
            let session = session.clone();
            tasks.spawn(async move { summary_of(&session, uri).await });
            if tasks.len() >= 40 {
                break;
            }
        }

        let mut out = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Ok(Some(summary)) = joined {
                out.push(summary);
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        if let Ok(mut slot) = PLAYLISTS.lock() {
            *slot = Some((Instant::now(), out.clone()));
        }
        Ok(out)
    }

    async fn summary_of(session: &Session, uri: SpotifyUri) -> Option<PlaylistSummary> {
        let playlist = Playlist::get(session, &uri).await.ok()?;
        Some(PlaylistSummary {
            uri: uri.to_uri().ok()?,
            name: playlist.name().to_string(),
            track_count: playlist.length as i64,
            art_url: cover_url(session, &playlist.attributes.picture),
        })
    }

    fn cover_url(session: &Session, picture: &[u8]) -> String {
        if picture.is_empty() {
            return String::new();
        }
        let Ok(file_id) = FileId::from_raw(picture).to_base16() else {
            return String::new();
        };
        let template = session
            .get_user_attribute("image-url")
            .unwrap_or_else(|| "https://i.scdn.co/image/{file_id}".to_string());
        template.replace("{file_id}", &file_id)
    }

    /// The tracks of one playlist (up to `TRACK_LIMIT`), fetched in parallel
    /// and cached per playlist.
    pub async fn playlist_tracks(uri: &str) -> Result<Vec<TrackSummary>, String> {
        if let Ok(guard) = TRACKS.lock() {
            if let Some((at, cached_uri, cached)) = guard.as_ref() {
                if cached_uri == uri && at.elapsed() < TRACKS_TTL {
                    return Ok(cached.clone());
                }
            }
        }

        let session = SESSION
            .lock()
            .map_err(|_| "state_poisoned".to_string())?
            .clone()
            .ok_or_else(|| "not_running".to_string())?;
        let parsed = SpotifyUri::from_uri(uri).map_err(|error| error.to_string())?;
        let playlist = Playlist::get(&session, &parsed)
            .await
            .map_err(|error| error.to_string())?;

        let mut tasks = tokio::task::JoinSet::new();
        for (index, item) in playlist.contents.items.iter().take(TRACK_LIMIT).enumerate() {
            let track_uri = item.id.clone();
            let session = session.clone();
            tasks.spawn(async move { (index, track_summary(&session, track_uri).await) });
        }

        let mut collected: Vec<(usize, TrackSummary)> = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Ok((index, Some(summary))) = joined {
                collected.push((index, summary));
            }
        }
        collected.sort_by_key(|(index, _)| *index);
        let out: Vec<TrackSummary> = collected.into_iter().map(|(_, summary)| summary).collect();
        if let Ok(mut slot) = TRACKS.lock() {
            *slot = Some((Instant::now(), uri.to_string(), out.clone()));
        }
        Ok(out)
    }

    async fn track_summary(session: &Session, uri: SpotifyUri) -> Option<TrackSummary> {
        let item = AudioItem::get_file(session, uri).await.ok()?;
        Some(TrackSummary {
            uri: item.uri.clone(),
            name: item.name.clone(),
            artist: artists_of(&item),
            album: album_of(&item),
            duration_ms: item.duration_ms as i64,
            art_url: item
                .covers
                .first()
                .map(|cover| cover.url.clone())
                .unwrap_or_default(),
        })
    }

    /// Makes the receiver the active device and starts a context on it,
    /// optionally starting at one specific track of the context.
    pub fn play(uri: &str, track_uri: Option<&str>) -> Result<(), String> {
        let spirc = SPIRC
            .lock()
            .map_err(|_| "state_poisoned".to_string())?
            .clone()
            .ok_or_else(|| "not_running".to_string())?;
        // Loading does nothing while another device is active; both commands
        // queue on the same channel, so activate lands first.
        let _ = spirc.activate();
        let request = LoadRequest::from_context_uri(
            uri.to_string(),
            LoadRequestOptions {
                start_playing: true,
                playing_track: track_uri.map(|track| PlayingTrack::Uri(track.to_string())),
                ..Default::default()
            },
        );
        spirc.load(request).map_err(|error| error.to_string())
    }

    /// Keeps `NOW` in sync with the player: metadata, position, volume, modes.
    async fn pump_events(mut events: PlayerEventChannel) {
        while let Some(event) = events.recv().await {
            let Ok(mut guard) = NOW.lock() else { continue };
            let Some(state) = guard.as_mut() else { continue };
            let at = Instant::now();
            match event {
                PlayerEvent::TrackChanged { audio_item } => {
                    state.item = Some(*audio_item);
                    state.position_ms = 0;
                    state.updated_at = Some(at);
                }
                PlayerEvent::Playing { position_ms, .. } => {
                    state.playing = true;
                    state.position_ms = position_ms;
                    state.updated_at = Some(at);
                }
                PlayerEvent::Paused { position_ms, .. } => {
                    state.playing = false;
                    state.position_ms = position_ms;
                    state.updated_at = Some(at);
                }
                PlayerEvent::Stopped { .. } => {
                    state.playing = false;
                    state.updated_at = Some(at);
                }
                PlayerEvent::Seeked { position_ms, .. }
                | PlayerEvent::PositionCorrection { position_ms, .. }
                | PlayerEvent::PositionChanged { position_ms, .. } => {
                    state.position_ms = position_ms;
                    state.updated_at = Some(at);
                }
                PlayerEvent::VolumeChanged { volume } => state.volume = volume,
                PlayerEvent::ShuffleChanged { shuffle } => state.shuffle = shuffle,
                PlayerEvent::RepeatChanged { context, track } => {
                    state.repeat_context = context;
                    state.repeat_track = track;
                }
                _ => {}
            }
        }
    }

    pub fn start(app: AppHandle) -> Result<PlaybackStatus, String> {
        if RUNNING.load(Ordering::Relaxed) {
            return Ok(status(&app));
        }
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        {
            let mut slot = STOP.lock().map_err(|_| "state_poisoned".to_string())?;
            if slot.is_some() {
                return Ok(status(&app));
            }
            *slot = Some(stop_tx);
        }
        // Drop state from an earlier run before a new engine starts.
        if let Ok(mut slot) = SPIRC.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = NOW.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = SESSION.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = PLAYLISTS.lock() {
            *slot = None;
        }

        let thread_app = app.clone();
        std::thread::spawn(move || {
            let outcome = run(thread_app, stop_rx, ready_tx);
            if let Err(error) = outcome {
                // Errors before "ready" are delivered through the channel;
                // this path only logs late failures.
                eprintln!("spotify playback engine ended: {error}");
            }
            RUNNING.store(false, Ordering::Relaxed);
            if let Ok(mut slot) = STOP.lock() {
                *slot = None;
            }
            if let Ok(mut slot) = SPIRC.lock() {
                *slot = None;
            }
            if let Ok(mut slot) = NOW.lock() {
                *slot = None;
            }
            if let Ok(mut slot) = SESSION.lock() {
                *slot = None;
            }
            if let Ok(mut slot) = PLAYLISTS.lock() {
                *slot = None;
            }
            if let Ok(mut slot) = TRACKS.lock() {
                *slot = None;
            }
        });

        // Pairing can wait for the browser, so allow a generous window.
        match ready_rx.recv_timeout(Duration::from_secs(600)) {
            Ok(Ok(())) => Ok(status(&app)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("timeout".to_string()),
        }
    }

    fn run(
        app: AppHandle,
        stop_rx: Receiver<()>,
        ready: Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(async move {
            match setup(&app).await {
                Ok((spirc, session)) => {
                    if let Ok(mut slot) = SESSION.lock() {
                        *slot = Some(session);
                    }
                    if let Ok(mut slot) = SPIRC.lock() {
                        *slot = Some(spirc.clone());
                    }
                    if let Ok(mut slot) = NOW.lock() {
                        *slot = Some(NowState::default());
                    }
                    RUNNING.store(true, Ordering::Relaxed);
                    let _ = ready.send(Ok(()));
                    // Park until the UI (or app exit) asks to stop; Spirc's
                    // task keeps serving Connect commands in the background.
                    loop {
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    let _ = spirc.shutdown();
                    Ok(())
                }
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    Err(error)
                }
            }
        })
    }

    async fn setup(app: &AppHandle) -> Result<(Arc<Spirc>, Session), String> {
        let session_config = SessionConfig::default();
        let token = ensure_token(app, &session_config).await?;
        let credentials = Credentials::with_access_token(token.access_token);

        let cache_dir = crate::spotify::data_dir(app).join("librespot");
        let files_dir = cache_dir.join("files");
        std::fs::create_dir_all(&files_dir).map_err(|error| error.to_string())?;
        let cache = Cache::new(
            Some(cache_dir.as_path()),
            Some(cache_dir.as_path()),
            Some(files_dir.as_path()),
            None,
        )
        .map_err(|error| error.to_string())?;

        let session = Session::new(session_config, Some(cache));
        let sink_builder = audio_backend::find(None).ok_or_else(|| "no_audio_backend".to_string())?;
        let mixer_builder = mixer::find(None).ok_or_else(|| "no_mixer".to_string())?;
        let mixer = mixer_builder(MixerConfig::default()).map_err(|error| error.to_string())?;
        let player = Player::new(
            PlayerConfig {
                // Periodic position events keep the overlay timeline honest.
                position_update_interval: Some(Duration::from_secs(1)),
                ..Default::default()
            },
            session.clone(),
            mixer.get_soft_volume(),
            move || sink_builder(None, AudioFormat::default()),
        );

        let events = player.get_player_event_channel();
        tokio::spawn(pump_events(events));
        tokio::spawn(token_refresh_loop(app.clone(), session.clone()));

        let connect_config = ConnectConfig {
            name: DEVICE_NAME.to_string(),
            device_type: DeviceType::Computer,
            // Volume is on the full u16 scale; u16::MAX / 2 is 50%.
            initial_volume: u16::MAX / 2,
            ..Default::default()
        };
        let (spirc, task) = Spirc::new(connect_config, session.clone(), credentials, player, mixer)
            .await
            .map_err(|error| error.to_string())?;
        tokio::spawn(task);
        spirc.activate().map_err(|error| error.to_string())?;
        Ok((Arc::new(spirc), session))
    }

    /// Stored token, refreshed when it is about to expire; otherwise the
    /// one-time browser approval runs and its tokens are stored.
    async fn ensure_token(
        app: &AppHandle,
        session_config: &SessionConfig,
    ) -> Result<PlaybackToken, String> {
        if let Some(saved) = load_token(app) {
            if saved.expires_at - 60 > now_unix() {
                return Ok(saved);
            }
            let client = OAuthClientBuilder::new(
                &session_config.client_id,
                REDIRECT_URI,
                vec!["streaming"],
            )
            .build()
            .map_err(|error| error.to_string())?;
            match client.refresh_token_async(&saved.refresh_token).await {
                Ok(token) => return Ok(store_token(app, token)),
                Err(_) => clear_token(app),
            }
        }

        let client = OAuthClientBuilder::new(
            &session_config.client_id,
            REDIRECT_URI,
            vec!["streaming"],
        )
        .open_in_browser()
        .with_custom_message(CALLBACK_HTML)
        .build()
        .map_err(|error| error.to_string())?;
        let token = client
            .get_access_token_async()
            .await
            .map_err(|error| error.to_string())?;
        Ok(store_token(app, token))
    }

    /// The spclient renews its HTTP token through login5, which exchanges the
    /// session's auth data — so that data has to stay fresh. Without this, all
    /// metadata (track changes, playlists) dies about an hour after start.
    async fn token_refresh_loop(app: AppHandle, session: Session) {
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let Some(saved) = load_token(&app) else { continue };
            // Refresh once it is within 25 minutes of expiry.
            if saved.expires_at - 1500 > now_unix() {
                continue;
            }
            let client = match OAuthClientBuilder::new(
                &session.client_id(),
                REDIRECT_URI,
                vec!["streaming"],
            )
            .build()
            {
                Ok(client) => client,
                Err(_) => continue,
            };
            let Ok(token) = client.refresh_token_async(&saved.refresh_token).await else {
                eprintln!("spotify token refresh failed; keeping the current one");
                continue;
            };
            session.set_auth_data(token.access_token.as_bytes());
            let remaining = token
                .expires_at
                .saturating_duration_since(Instant::now())
                .as_secs() as i64;
            let stored = PlaybackToken {
                access_token: token.access_token,
                // The response may rotate the refresh token; keep the old one
                // when it does not include a new one.
                refresh_token: if token.refresh_token.is_empty() {
                    saved.refresh_token
                } else {
                    token.refresh_token
                },
                expires_at: now_unix() + remaining.max(60),
            };
            save_token(&app, &stored);
        }
    }

    fn store_token(app: &AppHandle, token: OAuthToken) -> PlaybackToken {
        let remaining = token
            .expires_at
            .saturating_duration_since(Instant::now())
            .as_secs() as i64;
        let stored = PlaybackToken {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: now_unix() + remaining.max(60),
        };
        save_token(app, &stored);
        stored
    }
}

#[cfg(test)]
mod tests {
    use super::{percent_to_raw, raw_to_percent, repeat_label, web_url};

    #[test]
    fn track_uris_become_open_spotify_urls() {
        assert_eq!(
            web_url("spotify:track:abc123"),
            "https://open.spotify.com/track/abc123"
        );
        assert_eq!(
            web_url("spotify:episode:xyz"),
            "https://open.spotify.com/episode/xyz"
        );
        assert_eq!(web_url("not-a-uri"), "");
    }

    #[test]
    fn repeat_flags_map_to_the_three_states() {
        assert_eq!(repeat_label(false, false), "off");
        assert_eq!(repeat_label(true, false), "context");
        assert_eq!(repeat_label(true, true), "track");
    }

    #[test]
    fn volume_round_trips_on_the_u16_scale() {
        assert_eq!(raw_to_percent(0), 0);
        assert_eq!(raw_to_percent(u16::MAX), 100);
        assert_eq!(percent_to_raw(0), 0);
        assert_eq!(percent_to_raw(100), u16::MAX);
        assert_eq!(raw_to_percent(percent_to_raw(50)), 50);
    }
}
