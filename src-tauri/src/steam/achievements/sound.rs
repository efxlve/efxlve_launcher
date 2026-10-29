//! Achievement unlock sound: a synthesized chime for the active animation
//! style and rarity tier, or the custom file picked in Settings.
//!
//! Playback runs on a background thread; a newer sound cancels the one that is
//! still ringing.

#[cfg(windows)]
use std::path::Path;

use super::AchievementNotificationOptions;

/// Bumped by every new sound so the previous sink stops early.
#[cfg(windows)]
static SOUND_PLAY_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Smoothly raises from 0.0 to 1.0 over `attack_s` using a cosine curve so note
/// onsets never click.
#[cfg(windows)]
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
#[cfg(windows)]
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
                // PlayStation 5 Trophy: airy celestial synth pad + bright metallic trophy ping (G5 -> D6 -> F#6)
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
                // Prism Unfurl (default): PS5-inspired warm D-Maj9 crystal pad + chime arpeggio
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

/// Runs a Rodio decoder on a background thread and cancels early if a newer
/// achievement sound starts before it finishes.
#[cfg(windows)]
fn spawn_cancellable_sink<R>(decoder: rodio::Decoder<R>, volume: u8)
where
    R: std::io::Read + std::io::Seek + Send + Sync + 'static,
{
    let my_gen = SOUND_PLAY_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let vol = (volume.min(100) as f32) / 100.0;
    std::thread::spawn(move || {
        let Ok(stream) = rodio::OutputStreamBuilder::open_default_stream() else {
            unsafe {
                MessageBeep(0x00000040);
            }
            return;
        };
        let sink = rodio::Sink::connect_new(stream.mixer());
        sink.set_volume(vol);
        sink.append(decoder);
        while !sink.empty() {
            if SOUND_PLAY_GEN.load(std::sync::atomic::Ordering::Relaxed) != my_gen {
                sink.stop();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    });
}

/// Plays a custom notification file on a background thread so the watcher
/// never waits for the sound. Rodio decodes by content, so WAV, MP3, OGG,
/// FLAC, and M4A all work through the same path.
#[cfg(windows)]
fn play_custom_sound(path: &str, volume: u8) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(decoder) = rodio::Decoder::try_from(std::io::Cursor::new(bytes)) else {
        return false;
    };
    spawn_cancellable_sink(decoder, volume);
    true
}

#[cfg(windows)]
pub(super) fn play_achievement_notification_sound(
    app: &tauri::AppHandle,
    options: &AchievementNotificationOptions,
    tier: u8,
) {
    if !options.sound {
        return;
    }
    if options.custom_sound {
        let settings = crate::load_settings(app);
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
    if let Ok(decoder) = rodio::Decoder::try_from(std::io::Cursor::new(wav_bytes)) {
        spawn_cancellable_sink(decoder, options.volume);
        return;
    }
    const DEFAULT_CHIME: &[u8] = include_bytes!("../../../assets/achievement-chime.wav");
    if let Ok(decoder) = rodio::Decoder::try_from(std::io::Cursor::new(DEFAULT_CHIME)) {
        spawn_cancellable_sink(decoder, options.volume);
        return;
    }
    unsafe {
        MessageBeep(0x00000040);
    }
}

#[cfg(not(windows))]
pub(super) fn play_achievement_notification_sound(
    _app: &tauri::AppHandle,
    _options: &AchievementNotificationOptions,
    _tier: u8,
) {
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBeep(uType: u32) -> i32;
}
