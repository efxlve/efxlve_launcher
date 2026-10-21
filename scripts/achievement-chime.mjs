/**
 * Generates the launcher's achievement chime.
 *
 * The card is the launcher's own surface, so the sound is the launcher's own
 * too: a small celesta figure (E5, B5, E6) rather than a Windows notification
 * tone. Everything is synthesized here, so the file has no third-party audio in
 * it and can be regenerated at any time.
 *
 *   node scripts/achievement-chime.mjs
 *
 * Writes src-tauri/assets/achievement-chime.wav (44.1 kHz, mono, 16-bit PCM).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SAMPLE_RATE = 44_100;
const OUT = join("src-tauri", "assets", "achievement-chime.wav");

/** E5, B5, E6: a fifth and the octave on top, the classic "you did it". */
const NOTES = [
  { hz: 659.255, at: 0.0, gain: 0.9 },
  { hz: 987.767, at: 0.085, gain: 0.72 },
  { hz: 1318.51, at: 0.17, gain: 0.95 },
];

/** One celesta-ish note: a strong fundamental and quickly dying upper partials. */
function note(samples, hz, at, gain) {
  const start = Math.floor(at * SAMPLE_RATE);
  const length = Math.floor(1.15 * SAMPLE_RATE);
  const partials = [
    [1, 1.0],
    [2, 0.26],
    [3, 0.11],
    [4, 0.05],
  ];
  // A few cents of detune between two voices gives the chime its shimmer.
  for (const detune of [1, 1.0016]) {
    for (const [ratio, amount] of partials) {
      const frequency = hz * ratio * detune;
      if (frequency > SAMPLE_RATE / 2.2) continue;
      const decay = 0.92 / (1 + (ratio - 1) * 0.62);
      const attack = 0.004 + 0.002 * ratio;
      const amplitude = (gain * amount) / (detune === 1 ? 1 : 2);
      for (let i = 0; i < length; i += 1) {
        const t = i / SAMPLE_RATE;
        const envelope = Math.exp(-t / decay) * Math.min(1, t / attack);
        samples[start + i] += amplitude * envelope * Math.sin(2 * Math.PI * frequency * t);
      }
    }
  }
  // Soft body an octave down: the note gets weight without a low thump.
  const body = hz / 2;
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t / 0.55) * Math.min(1, t / 0.012);
    samples[start + i] += gain * 0.12 * envelope * Math.sin(2 * Math.PI * body * t);
  }
}

/** One-pole low-pass; `cut` is a coefficient in (0, 1]. */
function lowpass(samples, cut) {
  let value = 0;
  for (let i = 0; i < samples.length; i += 1) {
    value += cut * (samples[i] - value);
    samples[i] = value;
  }
}

/** A short, quiet tail: four low-passed taps, no feedback to keep it short. */
function addTail(samples, taps) {
  const copy = Float64Array.from(samples);
  for (const [delaySeconds, gain] of taps) {
    const delay = Math.floor(delaySeconds * SAMPLE_RATE);
    const wet = new Float64Array(copy.length);
    for (let i = 0; i + delay < copy.length; i += 1) wet[i + delay] = copy[i] * gain;
    lowpass(wet, 0.22);
    for (let i = 0; i < samples.length; i += 1) samples[i] += wet[i];
  }
}

function build() {
  const total = Math.ceil(1.45 * SAMPLE_RATE);
  const samples = new Float64Array(total);
  for (const { hz, at, gain } of NOTES) note(samples, hz, at, gain);

  addTail(samples, [
    [0.037, 0.24],
    [0.063, 0.16],
    [0.101, 0.1],
    [0.149, 0.06],
  ]);

  // Take the edge off the top end, then normalise with headroom: the settings
  // volume multiplies this, and a 100% chime must not clip.
  lowpass(samples, 0.42);
  lowpass(samples, 0.42);

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? 0.7 / peak : 0;

  // Fade the very end to zero so the file never clicks.
  const fade = Math.floor(0.16 * SAMPLE_RATE);
  for (let i = 0; i < fade; i += 1) {
    samples[samples.length - 1 - i] *= i / fade;
  }
  return samples.map((value) => value * scale);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const samples = build();
let peak = 0;
let sum = 0;
for (const value of samples) {
  peak = Math.max(peak, Math.abs(value));
  sum += value * value;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, wav(samples));
console.log(
  `${OUT}: ${(samples.length / SAMPLE_RATE).toFixed(2)}s, peak ${peak.toFixed(3)}, rms ${Math.sqrt(sum / samples.length).toFixed(3)}`,
);
