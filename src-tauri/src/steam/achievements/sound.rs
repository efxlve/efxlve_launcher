//! Achievement unlock sound: a synthesized chime for the active animation
//! style and rarity tier, or the custom file picked in Settings.
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

/// Synthesizes a stereo 44.1 kHz 16-bit PCM WAV chime tailored to the active
/// animation style ("prism", "cyber", "shatter", "jackpot") and rarity tier
/// (0 = bronze, 1 = silver, 2 = gold, 3 = ultra-rare diamond, 4 = platinum).
pub(super) fn synthesize_dopamine_chime_wav(style: &str, tier: u8) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 44_100;
    let duration_secs: f32 = match tier {
        0 | 1 => 1.55,
        2 => 1.90,
        3 => 2.25,
        _ => 2.65,
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
    let note_count: usize = match tier {
        0 => 3,
        1 => 4,
        2 => 5,
        _ => 6,
    };

    for i in 0..num_samples {
        let t = i as f32 / SAMPLE_RATE as f32;
        let mut left = 0.0f32;
        let mut right = 0.0f32;

        // 1. Analytic phase-integrated warm sub-bass thump (0.00s..0.24s)
        // Instantaneous frequency f(t) = 42 + 56 * exp(-8*t), integrated phase = 42*t + (56/8)*(1 - exp(-8*t))
        if t < 0.24 {
            let env = smooth_attack(t, 0.012) * (1.0 - t / 0.24).powi(2);
            let sub_phase = tau * (42.0 * t + (56.0 / 8.0) * (1.0 - (-8.0 * t).exp()));
            let sub = sub_phase.sin() * env * 0.20;
            left += sub;
            right += sub;
        }

        match style {
            "cyber" => {
                // Cyber Overload: warm analog synth fifths & octave arpeggio (A3, E4, A4, B4, C#5, E5)
                let notes: [f32; 6] = [220.00, 329.63, 440.00, 493.88, 554.37, 659.25];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = idx as f32 * 0.068;
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.016);
                        let decay = (-dt * (2.1 - (tier.min(4) as f32) * 0.18)).exp();
                        let fund_l = (dt * freq * 0.9985 * tau).sin();
                        let fund_r = (dt * freq * 1.0015 * tau).sin();
                        let harm2 = (dt * freq * 2.0 * tau).sin() * (-dt * 3.4).exp() * 0.32;
                        let harm3 = (dt * freq * 3.0 * tau).sin() * (-dt * 5.2).exp() * 0.12;
                        let amp = attack * decay * 0.14;
                        left += (fund_l + harm2 + harm3) * amp;
                        right += (fund_r + harm2 - harm3) * amp;
                    }
                }
            }
            "shatter" => {
                // Crystal Shatter: pure Lydian celesta / vibraphone harmonics (F5, G5, A5, C6, E6, G6)
                let notes: [f32; 6] = [698.46, 783.99, 880.00, 1046.50, 1318.51, 1567.98];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = idx as f32 * 0.065;
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.010);
                        let decay = (-dt * 2.2).exp();
                        let p1_l = (dt * freq * 0.998 * tau).sin();
                        let p1_r = (dt * freq * 1.002 * tau).sin();
                        let p2 = (dt * freq * 2.0 * tau).sin() * (-dt * 4.5).exp() * 0.28;
                        let p3 = (dt * freq * 3.0 * tau).sin() * (-dt * 7.5).exp() * 0.10;
                        let amp = attack * decay * 0.145;
                        left += (p1_l + p2 + p3) * amp;
                        right += (p1_r + p2 - p3) * amp;
                    }
                }
            }
            "jackpot" => {
                // Arcade Jackpot: crisp 3-note grace flourish into a lush Major-9th triumph chord
                let grace: [f32; 3] = [523.25, 659.25, 783.99];
                for (c, &f_grace) in grace.iter().enumerate() {
                    let onset = c as f32 * 0.062;
                    if t >= onset && t < onset + 0.36 {
                        let dt = t - onset;
                        let env = smooth_attack(dt, 0.010) * (-dt * 6.5).exp();
                        let pan = 0.35 + (c as f32) * 0.15;
                        let wave = ((dt * f_grace * tau).sin()
                            + 0.25 * (dt * f_grace * 2.0 * tau).sin())
                            * env
                            * 0.15;
                        left += wave * (1.0 - pan * 0.3);
                        right += wave * (0.7 + pan * 0.3);
                    }
                }
                let chord_onset = 0.18;
                if t >= chord_onset {
                    let dt = t - chord_onset;
                    let chord: [f32; 6] = [261.63, 523.25, 659.25, 783.99, 987.77, 1174.66];
                    let attack = smooth_attack(dt, 0.024);
                    let decay = (-dt * (1.65 - (tier.min(4) as f32) * 0.12)).exp();
                    for &freq in chord.iter().take(note_count) {
                        let l = (dt * freq * 0.9985 * tau).sin()
                            + 0.26 * (dt * freq * 2.0 * tau).sin() * (-dt * 3.2).exp();
                        let r = (dt * freq * 1.0015 * tau).sin()
                            + 0.26 * (dt * freq * 2.0 * tau).sin() * (-dt * 3.2).exp();
                        left += l * attack * decay * 0.105;
                        right += r * attack * decay * 0.105;
                    }
                }
            }
            "xbox" => {
                // Xbox Series Capsule: signature warm two-tone sonar chime (A4 -> E5) + rare diamond bell tail
                let notes: [f32; 6] = [440.00, 659.25, 880.00, 1108.73, 1318.51, 1760.00];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = if idx == 0 {
                        0.0
                    } else if idx == 1 {
                        0.135
                    } else {
                        0.26 + (idx - 2) as f32 * 0.068
                    };
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.015);
                        let decay = (-dt * (1.85 - (tier.min(4) as f32) * 0.15)).exp();
                        let fund_l = (dt * freq * 0.9988 * tau).sin();
                        let fund_r = (dt * freq * 1.0012 * tau).sin();
                        let over2 = (dt * freq * 2.0 * tau).sin() * (-dt * 3.6).exp() * 0.24;
                        let amp = attack * decay * (if idx <= 1 { 0.175 } else { 0.125 });
                        left += (fund_l + over2) * amp;
                        right += (fund_r + over2) * amp;
                    }
                }
            }
            "playstation" => {
                // Airy celestial synth pad + bright metallic trophy ping (G5 -> D6 -> F#6)
                let pad_env = smooth_attack(t, 0.05) * (-t * 1.35).exp() * 0.11;
                left += ((t * 196.00 * tau).sin() + 0.55 * (t * 293.66 * tau).sin()) * pad_env;
                right += ((t * 196.30 * tau).sin() + 0.55 * (t * 293.35 * tau).sin()) * pad_env;

                let notes: [f32; 6] = [783.99, 1174.66, 1479.98, 1567.98, 1975.53, 2349.32];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = 0.04 + idx as f32 * 0.058;
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.010);
                        let decay = (-dt * 2.15).exp();
                        let fund_l = (dt * freq * 0.9985 * tau).sin();
                        let fund_r = (dt * freq * 1.0015 * tau).sin();
                        let bell = (dt * freq * 2.41 * tau).sin() * (-dt * 5.8).exp() * 0.20;
                        let amp = attack * decay * 0.135;
                        left += (fund_l + bell) * amp;
                        right += (fund_r - bell) * amp;
                    }
                }
            }
            "epic" => {
                // Epic Games EOS Portal: modern crisp ascending triad + warm sub-octave resonance (C4, G4, D5, E5, G5, B5)
                let notes: [f32; 6] = [261.63, 392.00, 587.33, 659.25, 783.99, 987.77];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = idx as f32 * 0.062;
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.012);
                        let decay = (-dt * 1.95).exp();
                        let fund_l = (dt * freq * 0.9985 * tau).sin();
                        let fund_r = (dt * freq * 1.0015 * tau).sin();
                        let over2 = (dt * freq * 2.0 * tau).sin() * (-dt * 3.5).exp() * 0.30;
                        let amp = attack * decay * 0.145;
                        left += (fund_l + over2) * amp;
                        right += (fund_r + over2) * amp;
                    }
                }
            }
            _ => {
                // Prism Unfurl (default): warm D-Maj9 crystal pad + chime arpeggio
                let pad_env = smooth_attack(t, 0.045) * (-t * 1.45).exp() * 0.09;
                left += ((t * 146.83 * tau).sin() + 0.6 * (t * 220.00 * tau).sin()) * pad_env;
                right += ((t * 147.10 * tau).sin() + 0.6 * (t * 219.75 * tau).sin()) * pad_env;

                let notes: [f32; 6] = [587.33, 739.99, 880.00, 1108.73, 1318.51, 1760.00];
                for (idx, &freq) in notes.iter().take(note_count).enumerate() {
                    let onset = idx as f32 * 0.075;
                    if t >= onset {
                        let dt = t - onset;
                        let attack = smooth_attack(dt, 0.014);
                        let decay = (-dt * (2.05 - (tier.min(4) as f32) * 0.18)).exp();
                        let fund_l = (dt * freq * 0.9985 * tau).sin();
                        let fund_r = (dt * freq * 1.0015 * tau).sin();
                        let over2 = (dt * freq * 2.0 * tau).sin() * (-dt * 3.8).exp() * 0.26;
                        let over3 = (dt * freq * 3.0 * tau).sin() * (-dt * 6.2).exp() * 0.09;
                        let amp = attack * decay * 0.145;
                        left += (fund_l + over2 + over3) * amp;
                        right += (fund_r + over2 - over3) * amp;
                    }
                }
            }
        }

        // High-tier diamond/platinum warm choir shimmer tail (tiers 3 and 4)
        if tier >= 3 && t >= 0.30 {
            let dt = t - 0.30;
            let shimmer_env = smooth_attack(dt, 0.09) * (-dt * 1.55).exp();
            let vibrato = (dt * 6.5 * tau).sin() * 0.25 + 0.75;
            let s1 = (dt * 1174.66 * tau).sin();
            let s2 = (dt * 1479.98 * tau).sin();
            let s3 = if tier >= 4 {
                (dt * 1760.00 * tau).sin() * 0.7
            } else {
                0.0
            };
            let sparkle = (s1 + s2 + s3) * shimmer_env * 0.055 * vibrato;
            left += sparkle;
            right += sparkle * 0.94;
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
    let wav_bytes = synthesize_dopamine_chime_wav(&options.anim_style, tier);
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
