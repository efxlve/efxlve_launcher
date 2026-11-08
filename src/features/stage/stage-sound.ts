/**
 * Stage's tiny sound and haptic layer.
 *
 * The ticks are synthesised, not sampled: a short oscillator envelope keeps the
 * bundle free of audio assets and lets the settings page scale the volume. A
 * missing AudioContext or a pad without a vibration actuator simply stays
 * silent; neither is allowed to break navigation.
 */

import { S } from "../../core/state";

export type StageFeedback = "move" | "select" | "back" | "launch" | "error";

let audio: AudioContext | null = null;
let lastSoundAt = 0;

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
): void {
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
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
    void context.resume().catch(() => undefined);
  }
  const volume = (S.stage.soundVolume / 100) * 0.16;
  switch (kind) {
    case "move":
      tone(context, 820, 640, 0.035, volume * 0.35, "sine");
      break;
    case "select":
      tone(context, 480, 720, 0.08, volume * 0.65, "triangle");
      tone(context, 960, 1440, 0.06, volume * 0.25, "sine");
      break;
    case "back":
      tone(context, 540, 320, 0.075, volume * 0.5, "sine");
      break;
    case "launch":
      tone(context, 140, 520, 0.36, volume * 0.9, "sine");
      tone(context, 280, 1040, 0.28, volume * 0.4, "triangle");
      break;
    case "error":
      tone(context, 240, 160, 0.18, volume * 0.6, "square");
      break;
  }
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
