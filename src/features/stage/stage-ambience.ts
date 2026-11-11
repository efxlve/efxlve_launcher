/**
 * Stage's generative ambient theme.
 *
 * This is an original composition synthesised in the browser, not a sample of
 * a console theme: a slow D-major pad (Dmaj9, Bm11, Gmaj9, A6/9), a sparse
 * pentatonic bell line and a low air layer, all sent through a generated
 * impulse reverb. Nothing here is copied from, or depends on, a third-party
 * recording; it only aims for the *feeling* of a calm menu room.
 *
 * The module lives in the lazy Stage chunk. Desktop mode never pays for the
 * oscillators, and leaving Stage suspends the audio graph.
 */

import { S } from "../../core/state";

export type StageAmbienceScene = "home" | "library" | "quiet";

const CHORDS: number[][] = [
  // Dmaj9: D2 A2 D3 F#3 A3 E4
  [38, 45, 50, 54, 57, 64],
  // Bm11: B2 F#3 B3 D4 F#4 E4
  [47, 54, 59, 62, 66, 64],
  // Gmaj9: G2 D3 G3 B3 D4 A4
  [43, 50, 55, 59, 62, 69],
  // A6/9: A2 E3 A3 C#4 E4 F#4
  [45, 52, 57, 61, 64, 66],
];

/** D major pentatonic, two octaves: the only notes the bell line may use. */
const PENTATONIC = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86];

const CHORD_SECONDS = 9.6;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let dryBus: GainNode | null = null;
let wetBus: GainNode | null = null;
let running = false;
let generation = 0;
let chordIndex = 0;
let scene: StageAmbienceScene = "home";
let chordTimer = 0;
let melodyTimer = 0;
let volume = 50;
let ducked = false;
let unlocked = false;

function audioContext(): AudioContext | null {
  if (context) return context;
  try {
    const Ctor = window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * A generated stereo room: no asset, no fetch. 2.2 s is enough tail for a
 * menu pad and keeps the convolution light on a low-power handheld.
 */
function makeImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 2.2;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.6);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return buffer;
}

function ensureGraph(): boolean {
  const ctx = audioContext();
  if (!ctx) return false;
  if (master && dryBus && wetBus) return true;

  master = ctx.createGain();
  master.gain.value = 0.0001;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 24;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.02;
  compressor.release.value = 0.4;

  dryBus = ctx.createGain();
  dryBus.gain.value = 0.72;

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx);
  wetBus = ctx.createGain();
  wetBus.gain.value = 0.42;

  dryBus.connect(master);
  dryBus.connect(reverb);
  reverb.connect(wetBus);
  wetBus.connect(master);
  master.connect(compressor);
  compressor.connect(ctx.destination);

  // A little filtered air keeps the room from sounding like a dry synth.
  startAir(ctx);
  return true;
}

function startAir(ctx: AudioContext): void {
  try {
    const length = Math.floor(ctx.sampleRate * 4);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      // Brown-ish noise: softer than white noise under a lowpass.
      last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995;
      data[i] = last;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    source.connect(filter);
    filter.connect(gain);
    if (dryBus) gain.connect(dryBus);
    source.start();
  } catch {
    /* Air is optional; the pad still plays. */
  }
}

function sceneGain(): number {
  if (ducked) return 0.18;
  switch (scene) {
    case "library": return 0.72;
    case "quiet": return 0.38;
    default: return 1;
  }
}

function targetGain(): number {
  return Math.max(0.0001, (volume / 100) * 0.9 * sceneGain());
}

function rampMaster(to: number, seconds: number): void {
  const ctx = context;
  if (!ctx || !master) return;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), now + seconds);
}

function playPadChord(notes: number[], start: number, duration: number): void {
  const ctx = context;
  const dry = dryBus;
  const wet = wetBus;
  if (!ctx || !dry || !wet) return;
  notes.forEach((note, index) => {
    const frequency = midiToHz(note);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.35;
    filter.frequency.setValueAtTime(520 + index * 110, start);
    filter.frequency.linearRampToValueAtTime(880 + index * 160, start + duration * 0.45);
    filter.frequency.linearRampToValueAtTime(460 + index * 80, start + duration);

    const gain = ctx.createGain();
    const peak = index === 0 ? 0.075 : 0.052 - index * 0.003;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 2.8);
    gain.gain.setValueAtTime(Math.max(0.0001, peak * 0.92), start + duration - 3.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const sine = ctx.createOscillator();
    sine.type = "sine";
    sine.frequency.setValueAtTime(frequency, start);

    const triangle = ctx.createOscillator();
    triangle.type = "triangle";
    triangle.frequency.setValueAtTime(frequency, start);
    triangle.detune.setValueAtTime(index % 2 === 0 ? 4 : -4, start);

    sine.connect(filter);
    triangle.connect(filter);
    filter.connect(gain);
    gain.connect(dry);
    gain.connect(wet);

    sine.start(start);
    triangle.start(start);
    sine.stop(start + duration + 0.1);
    triangle.stop(start + duration + 0.1);
  });
}

function playBell(note: number, start: number): void {
  const ctx = context;
  const dry = dryBus;
  const wet = wetBus;
  if (!ctx || !dry || !wet) return;
  const frequency = midiToHz(note);
  const gain = ctx.createGain();
  const peak = 0.045;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 3.4);

  const tone = ctx.createOscillator();
  tone.type = "sine";
  tone.frequency.setValueAtTime(frequency, start);

  const shimmer = ctx.createOscillator();
  shimmer.type = "triangle";
  shimmer.frequency.setValueAtTime(frequency * 2.004, start);
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.22;

  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.random() * 1.2 - 0.6;

  tone.connect(gain);
  shimmer.connect(shimmerGain);
  shimmerGain.connect(gain);
  gain.connect(pan);
  pan.connect(dry);
  pan.connect(wet);

  tone.start(start);
  shimmer.start(start);
  tone.stop(start + 3.5);
  shimmer.stop(start + 3.5);
}

function scheduleChord(token: number): void {
  if (!running || token !== generation) return;
  const ctx = context;
  if (!ctx) return;
  const start = ctx.currentTime + 0.08;
  playPadChord(CHORDS[chordIndex % CHORDS.length], start, CHORD_SECONDS + 1.8);
  chordIndex += 1;
  chordTimer = window.setTimeout(() => scheduleChord(token), CHORD_SECONDS * 1000);
}

function scheduleBell(token: number): void {
  if (!running || token !== generation) return;
  const ctx = context;
  if (!ctx) return;
  const wait = scene === "quiet" ? 9000 : 4600;
  const delay = wait + Math.random() * wait;
  melodyTimer = window.setTimeout(() => {
    if (!running || token !== generation) return;
    const note = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
    playBell(note, ctx.currentTime + 0.05);
    scheduleBell(token);
  }, delay);
}

function bindUnlock(): void {
  if (unlocked) return;
  unlocked = true;
  const unlock = (): void => {
    const ctx = audioContext();
    if (ctx?.state === "suspended") void ctx.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Start (or resume) the theme for an active Stage session. */
export function startStageAmbience(): void {
  if (!S.stage.active || !S.stage.ambience) return;
  bindUnlock();
  if (!ensureGraph()) return;
  const ctx = context;
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  if (running) {
    // A background render must not undo the visibility mute.
    if (!document.hidden) rampMaster(targetGain(), 1.2);
    return;
  }
  running = true;
  generation += 1;
  chordIndex = 0;
  volume = S.stage.ambienceVolume;
  rampMaster(document.hidden ? 0.0001 : targetGain(), 3.2);
  scheduleChord(generation);
  scheduleBell(generation);
}

/** Fade out and park the graph. The context is reused on the next entry. */
export function stopStageAmbience(): void {
  running = false;
  generation += 1;
  if (chordTimer) window.clearTimeout(chordTimer);
  if (melodyTimer) window.clearTimeout(melodyTimer);
  chordTimer = 0;
  melodyTimer = 0;
  if (!context || !master) return;
  rampMaster(0.0001, 1.8);
  const ctx = context;
  window.setTimeout(() => {
    if (running) return;
    void ctx.suspend().catch(() => undefined);
  }, 2300);
}

/** Route changes make the room breathe: Home is full, tools are quieter. */
export function setStageAmbienceScene(next: StageAmbienceScene): void {
  if (scene === next && running) return;
  scene = next;
  if (!running) return;
  rampMaster(targetGain(), 1.6);
}

/** Lower the theme under the launch curtain without stopping the scheduler. */
export function duckStageAmbience(on: boolean): void {
  if (ducked === on) return;
  ducked = on;
  if (!running) return;
  rampMaster(targetGain(), on ? 0.5 : 1.4);
}

/** Settings changes reach a live session without a restart. */
export function applyStageAmbienceSettings(): void {
  volume = S.stage.ambienceVolume;
  if (!S.stage.ambience) {
    stopStageAmbience();
    return;
  }
  if (!running) startStageAmbience();
  else rampMaster(targetGain(), 0.6);
}

export function stageAmbienceActive(): boolean {
  return running;
}

// Leaving Stage releases the audio device; visibility changes duck the room
// instead of stopping the scheduler, so returning to the tab is seamless.
window.addEventListener("stage-mode", (event) => {
  if ((event as CustomEvent<{ active?: boolean }>).detail?.active) return;
  stopStageAmbience();
});

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    rampMaster(document.hidden ? 0.0001 : targetGain(), document.hidden ? 0.4 : 1.1);
  });
}
