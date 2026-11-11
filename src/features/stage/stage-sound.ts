/**
 * Stage's tiny sound and haptic layer.
 *
 * The ticks are synthesised, not sampled: a short oscillator envelope keeps the
 * bundle free of audio assets and lets the settings page scale the volume. A
 * missing AudioContext or a pad without a vibration actuator simply stays
 * silent; neither is allowed to break navigation.
 */

import { S } from "../../core/state";

export type StageFeedback = "move" | "select" | "back" | "launch" | "error" | "toggle" | "tab" | "boot" | "bump";

let audio: AudioContext | null = null;
let lastSoundAt = 0;
let noiseBuffer: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  if (audio) return audio;
  try {
    const Ctor = window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor();
    return audio;
  } catch {
    return null;
  }
}

function tone(
  context: AudioContext,
  frequency: number,
  endFrequency: number,
  duration: number,
  gainValue: number,
  type: OscillatorType,
  delay = 0,
): void {
  const now = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), now + Math.min(0.05, duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

/**
 * A short filtered-noise transient. It rounds off the synthesised tones with
 * the soft "air" a real console UI has under its clicks.
 */
function air(
  context: AudioContext,
  duration: number,
  gainValue: number,
  frequency: number,
): void {
  try {
    if (!noiseBuffer) {
      const length = Math.max(1, Math.floor(context.sampleRate * 0.4));
      noiseBuffer = context.createBuffer(1, length, context.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = 0.7;
    const gain = context.createGain();
    const now = context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(now);
    source.stop(now + duration + 0.02);
  } catch {
    /* A missing noise buffer must never break navigation. */
  }
}

/** Synthesised UI tick; returns immediately when the setting is off. */
export function playStageSound(kind: StageFeedback): void {
  if (!S.stage.sound || S.stage.soundVolume <= 0) return;
  const now = performance.now();
  if (kind === "move" && now - lastSoundAt < 35) return;
  lastSoundAt = now;
  const context = ctx();
  if (!context) return;
  if (context.state === "suspended") {
    void context.resume().then(() => {
      playStageSound(kind);
    }).catch(() => undefined);
    return;
  }
  const volume = (S.stage.soundVolume / 100) * 0.22;
  switch (kind) {
    case "bump":
      // A soft low-frequency boundary thump
      tone(context, 130, 80, 0.038, volume * 0.28, "sine");
      air(context, 0.025, volume * 0.06, 900);
      break;
    case "move":
      // A quiet wooden tick, not a beep: the high transient does the work.
      tone(context, 690, 640, 0.022, volume * 0.22, "sine");
      air(context, 0.024, volume * 0.1, 1600);
      break;
    case "select":
      tone(context, 784, 784, 0.075, volume * 0.55, "sine");
      tone(context, 1175, 1175, 0.09, volume * 0.26, "sine", 0.012);
      air(context, 0.05, volume * 0.12, 2400);
      break;
    case "back":
      tone(context, 523, 392, 0.11, volume * 0.42, "sine");
      tone(context, 262, 233, 0.09, volume * 0.3, "triangle", 0.02);
      break;
    case "launch":
      // A deep swell with a rising fifth: the curtain gets its own note.
      tone(context, 55, 110, 0.55, volume * 0.85, "sine");
      tone(context, 220, 330, 0.5, volume * 0.45, "triangle");
      tone(context, 440, 660, 0.42, volume * 0.28, "sine", 0.08);
      tone(context, 880, 990, 0.3, volume * 0.16, "sine", 0.16);
      air(context, 0.4, volume * 0.1, 900);
      break;
    case "error":
      tone(context, 233, 174, 0.22, volume * 0.55, "triangle");
      tone(context, 116, 110, 0.24, volume * 0.3, "sine");
      break;
    case "toggle":
      tone(context, 587, 659, 0.07, volume * 0.4, "sine");
      air(context, 0.03, volume * 0.1, 1800);
      break;
    case "tab":
      tone(context, 659, 880, 0.085, volume * 0.4, "sine");
      tone(context, 988, 1318, 0.08, volume * 0.2, "sine", 0.02);
      air(context, 0.08, volume * 0.12, 2800);
      break;
    case "boot":
      // A slow major add9 (D3 A3 D4 E4) for the Stage mark.
      tone(context, 146.8, 146.8, 2.2, volume * 0.5, "sine");
      tone(context, 220, 220, 2.1, volume * 0.34, "sine", 0.06);
      tone(context, 293.7, 293.7, 2.0, volume * 0.3, "triangle", 0.12);
      tone(context, 329.6, 329.6, 1.8, volume * 0.22, "sine", 0.18);
      tone(context, 587.3, 587.3, 1.2, volume * 0.12, "sine", 0.4);
      air(context, 0.6, volume * 0.08, 1200);
      break;
  }
}

/** Pre-unlock audio context on user interaction to avoid browser policy mute. */
export function unlockStageAudio(): void {
  const context = ctx();
  if (context && context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

if (typeof window !== "undefined") {
  const unlock = () => {
    unlockStageAudio();
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** A short test burst for the settings page. */
export function previewStageSound(): void {
  playStageSound("select");
}

function hapticsAvailable(): Gamepad | null {
  if (!S.stage.haptics) return null;
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (pad?.connected) return pad;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function vibrate(kind: StageFeedback): void {
  const pad = hapticsAvailable();
  if (!pad) return;
  const actuator = (pad as Gamepad & {
    vibrationActuator?: {
      playEffect?: (
        type: string,
        params: { duration: number; strongMagnitude: number; weakMagnitude: number },
      ) => Promise<unknown>;
    };
  }).vibrationActuator;
  if (!actuator?.playEffect) return;
  const effect = {
    move: { duration: 9, strongMagnitude: 0.08, weakMagnitude: 0.03 },
    select: { duration: 22, strongMagnitude: 0.22, weakMagnitude: 0.12 },
    back: { duration: 16, strongMagnitude: 0.16, weakMagnitude: 0.08 },
    launch: { duration: 70, strongMagnitude: 0.34, weakMagnitude: 0.2 },
    error: { duration: 55, strongMagnitude: 0.3, weakMagnitude: 0.3 },
    toggle: { duration: 14, strongMagnitude: 0.15, weakMagnitude: 0.08 },
    tab: { duration: 18, strongMagnitude: 0.18, weakMagnitude: 0.1 },
    boot: { duration: 120, strongMagnitude: 0.2, weakMagnitude: 0.1 },
    bump: { duration: 25, strongMagnitude: 0.18, weakMagnitude: 0.08 },
  }[kind];
  void actuator.playEffect("dual-rumble", effect).catch(() => undefined);
}

/** One call for the whole feedback contract. */
export function stageFeedback(kind: StageFeedback): void {
  playStageSound(kind);
  vibrate(kind);
}

// A Stage session owns the audio context; closing it releases the device when
// the mode ends without keeping a silent graph alive for the desktop.
window.addEventListener("stage-mode", (event) => {
  if ((event as CustomEvent<{ active?: boolean }>).detail?.active) return;
  try {
    void audio?.close();
  } catch {
    /* ignore */
  }
  audio = null;
});
