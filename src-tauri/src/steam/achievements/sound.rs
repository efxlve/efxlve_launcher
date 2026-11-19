//! Achievement unlock sound: a synthesized chime for the rarity tier, or the
//! custom file picked in Settings.
//!
//! One worker owns the default output stream and reuses it for every chime, so
//! a notification does not pay the audio-device open cost each time. A newer
//! sound stops the sink that is still ringing.

use std::path::Path;

use super::AchievementNotificationOptions;

const AUDIO_IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(300);

/// Smoothly raises from 0.0 to 1.0 over `attack_s` using a cosine curve so note
/// onsets never click.
#[inline]
fn smooth_attack(dt: f32, attack_s: f32) -> f32 {
    if dt <= 0.0 {
        0.0
    } else if dt >= attack_s {
        1.0
    } else {
        let u = dt / attack_s;
        0.5 - 0.5 * (u * std::f32::consts::PI).cos()
    }
}

/// Synthesizes the stereo 44.1 kHz 16-bit PCM WAV unlock chime: two soft bell
/// notes (A5, E6) that gain a third an octave up on rarer unlocks. No sub-bass
/// thump, arpeggio flourish or shimmer choir: the card is quiet, the sound is
/// the same, and a long game session does not turn every unlock into a fanfare.
pub(super) fn synthesize_notification_chime_wav(tier: u8) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 44_100;
    let tier = tier.min(4);
    let duration_secs: f32 = match tier {
        0 | 1 => 1.25,
        2 => 1.45,
        3 => 1.65,
        _ => 1.85,
    };
    let num_samples = (SAMPLE_RATE as f32 * duration_secs) as usize;
    let data_bytes = (num_samples * 4) as u32;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);

    // Standard RIFF/WAVE header (44 bytes, stereo 16-bit PCM).
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&2u16.to_le_bytes()); // 2 channels
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 4).to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());

    let tau = std::f32::consts::TAU;
    let notes: [f32; 3] = [880.00, 1318.51, 1760.00];
    let note_count = if tier >= 2 { 3 } else { 2 };
    // Rarer unlocks ring slightly longer instead of getting louder.
    let decay = 2.9 - tier as f32 * 0.18;

    for i in 0..num_samples {
        let t = i as f32 / SAMPLE_RATE as f32;
        let mut left = 0.0f32;
        let mut right = 0.0f32;

        for (idx, &freq) in notes.iter().take(note_count).enumerate() {
            let onset = idx as f32 * 0.105;
            if t < onset {
                continue;
            }
            let dt = t - onset;
            let env = smooth_attack(dt, 0.008) * (-dt * decay).exp();
            let fund_l = (dt * freq * 0.9985 * tau).sin();
            let fund_r = (dt * freq * 1.0015 * tau).sin();
            let octave = (dt * freq * 2.0 * tau).sin() * (-dt * 5.2).exp() * 0.22;
            let amp = env * 0.13;
            left += (fund_l + octave) * amp;
            right += (fund_r + octave) * amp;
        }

        // Gentle fade-out over the final 80ms so the buffer end is 100% silent
        let tail_rem = (duration_secs - t).max(0.0);
        let tail_fade = (tail_rem / 0.08).clamp(0.0, 1.0);
        let sample_l = ((left * tail_fade).tanh() * 28_000.0).clamp(-32_767.0, 32_767.0) as i16;
        let sample_r = ((right * tail_fade).tanh() * 28_000.0).clamp(-32_767.0, 32_767.0) as i16;
        wav.extend_from_slice(&sample_l.to_le_bytes());
        wav.extend_from_slice(&sample_r.to_le_bytes());
    }

    wav
}

/// One decoded request for the audio worker.
struct SoundRequest {
    bytes: Vec<u8>,
    volume: u8,
}

/// The worker is started on the first sound and keeps the default output
/// stream for five idle minutes; a long game session does not reopen WASAPI
/// for every achievement.
static SOUND_TX: std::sync::Mutex<Option<std::sync::mpsc::Sender<SoundRequest>>> =
    std::sync::Mutex::new(None);

fn enqueue_sound(bytes: Vec<u8>, volume: u8) {
    let mut slot = match SOUND_TX.lock() {
        Ok(slot) => slot,
        Err(_) => return,
    };
    if slot.is_none() {
        let (tx, rx) = std::sync::mpsc::channel::<SoundRequest>();
        std::thread::spawn(move || run_sound_worker(rx));
        *slot = Some(tx);
    }
    let Some(tx) = slot.as_ref() else {
        return;
    };
    if tx.send(SoundRequest { bytes, volume }).is_err() {
        // The worker died: the next sound starts a fresh one.
        *slot = None;
    }
}

fn run_sound_worker(rx: std::sync::mpsc::Receiver<SoundRequest>) {
    let mut stream: Option<rodio::OutputStream> = None;
    let mut sink: Option<rodio::Sink> = None;
    let mut idle_since = std::time::Instant::now();
    loop {
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(request) => {
                if stream.is_none() {
                    match rodio::OutputStreamBuilder::open_default_stream() {
                        Ok(next) => stream = Some(next),
                        Err(_) => {
                            beep();
                            continue;
                        }
                    }
                }
                // A new unlock replaces the chime that is still ringing instead
                // of layering the two.
                if let Some(previous) = sink.take() {
                    previous.stop();
                }
                let Some(active) = stream.as_ref() else {
                    continue;
                };
                let Ok(decoder) = rodio::Decoder::try_from(std::io::Cursor::new(request.bytes))
                else {
                    beep();
                    continue;
                };
                let next = rodio::Sink::connect_new(active.mixer());
                next.set_volume((request.volume.min(100) as f32) / 100.0);
                next.append(decoder);
                sink = Some(next);
                idle_since = std::time::Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let idle = sink.as_ref().map(|sink| sink.empty()).unwrap_or(true);
                if idle && stream.is_some() && idle_since.elapsed() >= AUDIO_IDLE_RELEASE {
                    // Release the device after a quiet stretch. The next sound
                    // pays one device-open cost and then stays warm again.
                    sink = None;
                    stream = None;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Reads and validates a custom notification file before handing it to the
/// worker. Rodio decodes by content, so WAV, MP3, OGG, FLAC and M4A all work.
fn play_custom_sound(path: &str, volume: u8) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.is_empty() {
        return false;
    }
    // Reject a corrupt file here so the caller can fall back to the built-in
    // chime. The decoder needs an owned cursor, so the bytes are cloned once;
    // a notification file is small compared with the playback it starts.
    if rodio::Decoder::try_from(std::io::Cursor::new(bytes.clone())).is_err() {
        return false;
    }
    enqueue_sound(bytes, volume);
    true
}

fn play_achievement_sound(
    app: &tauri::AppHandle,
    options: &AchievementNotificationOptions,
    tier: u8,
) {
    let settings = crate::load_settings(app);
    if tier >= 3 {
        if let Some(rare_path) = settings
            .achievement_notifications_rare_sound_path
            .as_deref()
            .filter(|path| Path::new(path).is_file())
        {
            if play_custom_sound(rare_path, options.volume) {
                return;
            }
        }
    }
    if options.custom_sound {
        if let Some(path) = settings
            .achievement_notifications_sound_path
            .as_deref()
            .filter(|path| Path::new(path).is_file())
        {
            if play_custom_sound(path, options.volume) {
                return;
            }
        }
    }
    let wav_bytes = synthesize_notification_chime_wav(tier);
    const DEFAULT_CHIME: &[u8] = include_bytes!("../../../assets/achievement-chime.wav");
    let bytes = if wav_bytes.is_empty() {
        DEFAULT_CHIME.to_vec()
    } else {
        wav_bytes
    };
    enqueue_sound(bytes, options.volume);
}

pub(super) fn play_achievement_notification_sound(
    app: &tauri::AppHandle,
    options: &AchievementNotificationOptions,
    tier: u8,
) {
    if !options.sound {
        return;
    }
    play_achievement_sound(app, options, tier);
}

/// Settings preview: the sound switch must not silence an explicit audition,
/// but the custom file and volume still follow the current options.
pub(super) fn audition_achievement_notification_sound(
    app: &tauri::AppHandle,
    options: &AchievementNotificationOptions,
    tier: u8,
) {
    play_achievement_sound(app, options, tier);
}

/// Best-effort system beep when the output device cannot be opened. Unix has
/// no portable equivalent, so that failure is silent there.
fn beep() {
    #[cfg(windows)]
    unsafe {
        MessageBeep(0x00000040);
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBeep(uType: u32) -> i32;
}
