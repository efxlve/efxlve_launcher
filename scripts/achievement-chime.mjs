/**
 * Generates the launcher's warm velvet achievement chime.
 *
 * Designed to be soothing, warm, rewarding, and ear-pleasing (never shrill or piercing).
 * Uses warm D-major acoustic bell harmonics (D4, A4, D5, F#5) with a rich body,
 * smooth attacks, and gentle decay.
 *
 *   node scripts/achievement-chime.mjs
 *
 * Writes src-tauri/assets/achievement-chime.wav (44.1 kHz, mono, 16-bit PCM).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SAMPLE_RATE = 44_100;
const OUT = join("src-tauri", "assets", "achievement-chime.wav");

/** Warm D-major harmonic ascent: rich, lush, console-grade rewarding chime. */
const NOTES = [
  { hz: 293.665, at: 0.0,   gain: 0.85 }, // D4
  { hz: 440.000, at: 0.090, gain: 0.75 }, // A4
  { hz: 587.330, at: 0.180, gain: 0.70 }, // D5
  { hz: 739.989, at: 0.260, gain: 0.50 }, // F#5
];

/** Warm acoustic chime note with soft attack and warm harmonics. */
function note(samples, hz, at, gain) {
  const start = Math.floor(at * SAMPLE_RATE);
  const length = Math.floor(1.35 * SAMPLE_RATE);
  const partials = [
    [1, 1.0],
    [2, 0.18],
    [3, 0.06],
  ];

  // Subtle warm detuning (1.0008) for analog shimmer without chorus wobble
  for (const detune of [1, 1.0008]) {
    for (const [ratio, amount] of partials) {
      const frequency = hz * ratio * detune;
      if (frequency > SAMPLE_RATE / 2.2) continue;
      const decay = 0.85 / (1 + (ratio - 1) * 0.75);
      const attack = 0.018 + 0.004 * ratio; // Soft attack (no ear-piercing click)
      const amplitude = (gain * amount) / (detune === 1 ? 1 : 2);
      for (let i = 0; i < length; i += 1) {
        if (start + i >= samples.length) break;
        const t = i / SAMPLE_RATE;
        const envelope = Math.exp(-t / decay) * Math.min(1, t / attack);
        samples[start + i] += amplitude * envelope * Math.sin(2 * Math.PI * frequency * t);
      }
    }
  }

  // Deep warm fundamental body
  const body = hz / 2;
  for (let i = 0; i < length; i += 1) {
    if (start + i >= samples.length) break;
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t / 0.50) * Math.min(1, t / 0.022);
    samples[start + i] += gain * 0.18 * envelope * Math.sin(2 * Math.PI * body * t);
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

/** Warm ambient room reflection. */
function addTail(samples, taps) {
  const copy = Float64Array.from(samples);
  for (const [delaySeconds, gain] of taps) {
    const delay = Math.floor(delaySeconds * SAMPLE_RATE);
    const wet = new Float64Array(copy.length);
    for (let i = 0; i + delay < copy.length; i += 1) wet[i + delay] = copy[i] * gain;
    lowpass(wet, 0.20);
    for (let i = 0; i < samples.length; i += 1) samples[i] += wet[i];
  }
}

function build() {
  const total = Math.ceil(1.65 * SAMPLE_RATE);
  const samples = new Float64Array(total);
  for (const { hz, at, gain } of NOTES) note(samples, hz, at, gain);

  addTail(samples, [
    [0.045, 0.22],
    [0.080, 0.15],
    [0.125, 0.09],
    [0.180, 0.05],
  ]);

  // Warm acoustic low-pass to eliminate high-frequency shrillness
  lowpass(samples, 0.28);
  lowpass(samples, 0.28);

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? 0.72 / peak : 0;

  // Smooth fade-out at the tail
  const fade = Math.floor(0.20 * SAMPLE_RATE);
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
