/**
 * Builds the small offline CPU/GPU score table from Blender Open Data.
 *
 * Source: https://opendata.blender.org (public-domain / CC0 benchmark data).
 * The score is Cycles render performance, not a game benchmark. It is used
 * only as a coarse relative proxy; close or unknown models stay partial.
 *
 * Run with: node scripts/build-hardware-scores.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const QUERY =
  "https://opendata.blender.org/benchmarks/query/?group_by=device_name&response_type=datatables";
const OUT = join("src", "features", "drawer", "hardware-scores.json");

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/\(r\)|\(tm\)/g, " ")
    .replace(/\b\d+\s?(?:gb|mb)\b/g, " ")
    .replace(/@.*$/g, " ")
    .replace(/\b(cpu|processor|graphics|series|gpu|laptop gpu|mobile gpu|max-q|max q|with max-q design)\b/g, (m) =>
      m.includes("laptop") ? "laptop" : m.includes("max") ? "maxq" : " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gpuKeys(name) {
  const n = normalize(name);
  const keys = new Set();
  for (const m of n.matchAll(/\b(rtx|gtx|gt)\s*(\d{3,4})\s*(ti|super|laptop|mobile|maxq)?\s*(laptop|mobile|maxq)?/g)) {
    const parts = [m[1], m[2], m[3], m[4]].filter(Boolean);
    keys.add(parts.join(" "));
  }
  for (const m of n.matchAll(/\b(rx|hd)\s*(\d{3,4})\s*(xtx|xt|gre|super|laptop|mobile)?/g)) {
    const parts = [m[1], m[2], m[3]].filter(Boolean);
    keys.add(parts.join(" "));
  }
  for (const m of n.matchAll(/\barc\s*([ab])\s*(\d{3})\b/g)) {
    keys.add(`arc ${m[1]}${m[2]}`);
  }
  if (/\biris\s*xe\b/.test(n)) keys.add("iris xe");
  for (const m of n.matchAll(/\bvega (\d{1,2})\b/g)) {
    keys.add(`vega ${m[1]}`);
  }
  // RDNA2/RDNA3 integrated GPUs ("Radeon 680M").
  for (const m of n.matchAll(/\bradeon (\d{3})m\b/g)) {
    keys.add(`radeon ${m[1]}m`);
  }
  for (const m of n.matchAll(/\b(uhd|hd)\s*(\d{3})\b/g)) {
    keys.add(`${m[1]} ${m[2]}`);
  }
  return [...keys];
}

function cpuKeys(name) {
  const n = normalize(name);
  const keys = new Set();
  for (const m of n.matchAll(/\bi([3579])[- ]?(\d{4,5}[a-z]*)\b/g)) {
    keys.add(`i${m[1]}-${m[2]}`);
  }
  // Core 2 (2006-2009). Desktop models carry an E/Q prefix, but Windows also
  // reports "Core2 CPU 6300" for an E6300, so a bare number becomes E-series.
  // Rows also spell the model apart from the family ("Core2 Duo 1.86 GHz
  // (E6300)"), so the model code is searched across the whole name.
  if (/\bcore\s*2\b/.test(n)) {
    const model =
      /\b([eqptx]\d{3,4}[a-z]?)\b/.exec(n) ??
      /\bcore\s*2\b(?:\s*(?:duo|quad|extreme))?\s*(?:cpu\s*)?(\d{4})\b/.exec(n);
    keys.add(model ? `core 2 ${/^\d/.test(model[1]) ? `e${model[1]}` : model[1]}` : "core 2");
  }
  // Athlon 64 X2 (2005-2007); the model number can follow "Dual Core".
  for (const m of n.matchAll(
    /\bathlon\s*64\s*x2\b(?:\s*dual core)?(?:\s*(\d{3,4}))?/g,
  )) {
    keys.add(m[1] ? `athlon 64 x2 ${m[1]}` : "athlon 64 x2");
  }
  // Athlon II X2/X3/X4 (2009-2011).
  for (const m of n.matchAll(
    /\bathlon\s*ii\s*x([234])\b(?:\s*(\d{3,4}[a-z]?))?/g,
  )) {
    keys.add(m[2] ? `athlon ii x${m[1]} ${m[2]}` : `athlon ii x${m[1]}`);
  }
  // Athlon X4 (2013-2015) and the 200GE/3000G line.
  for (const m of n.matchAll(
    /\bathlon\s*x([234])\b(?:\s*(\d{3,4}[a-z]?))?/g,
  )) {
    keys.add(m[2] ? `athlon x${m[1]} ${m[2]}` : `athlon x${m[1]}`);
  }
  for (const m of n.matchAll(/\bathlon\s+(\d{3,4}[a-z]{0,2})\b/g)) {
    keys.add(`athlon ${m[1]}`);
  }
  // Phenom II X2/X3/X4/X6 (2009-2011).
  for (const m of n.matchAll(
    /\bphenom\s*ii\s*x([2346])\b(?:\s*(\d{3,4}[a-z]?))?/g,
  )) {
    keys.add(m[2] ? `phenom ii x${m[1]} ${m[2]}` : `phenom ii x${m[1]}`);
  }
  // FX-4300..FX-9590. The FX APUs are reported with "Radeon" and are skipped
  // as GPUs before this runs.
  for (const m of n.matchAll(/\bfx\s*(\d{4}[a-z]?)\b/g)) {
    keys.add(`fx ${m[1]}`);
  }
  for (const m of n.matchAll(/\bultra ([3579]) (\d{3}[a-z]*)\b/g)) {
    keys.add(`ultra ${m[1]} ${m[2]}`);
  }
  // The "Core 7 150U" rebrand has no i-prefix.
  for (const m of n.matchAll(/\bcore ([3579]) (\d{3}[a-z]*)\b/g)) {
    keys.add(`core ${m[1]} ${m[2]}`);
  }
  for (const m of n.matchAll(/\bryzen\s*([3579])\s*(\d{4}[a-z]*)\b/g)) {
    keys.add(`ryzen ${m[1]} ${m[2]}`);
  }
  for (const m of n.matchAll(/\bryzen ai ([3579])(?: pro)? (?:h )?(\d{3}[a-z]*)\b/g)) {
    keys.add(`ryzen ai ${m[1]} ${m[2]}`);
  }
  for (const m of n.matchAll(/\bapple m([1-9])(?: (pro|max|ultra))?/g)) {
    keys.add(`apple m${m[1]}${m[2] ? ` ${m[2]}` : ""}`);
  }
  return [...keys];
}

function isGpu(name) {
  return (
    /nvidia|geforce|rtx|gtx|radeon|rx |intel arc|iris xe|uhd|vega/i.test(name) &&
    !/zluda|quadro|tesla|firepro|instinct|radeon pro|rtx a\d|data center|a100|h100/i.test(name)
  );
}

function isCpu(name) {
  if (/xeon|epyc|zluda/i.test(name)) return false;
  if (/^apple m\d/i.test(name)) return !/\(gpu/i.test(name);
  // The Core 2, Athlon, Phenom and FX families are old enough that a game
  // still asks for them by name; the score table starts there.
  return /intel core|amd ryzen|threadripper|core\s*2|athlon|phenom|amd fx-/i.test(name);
}

/** Old parts rarely have three benchmark samples on Open Data. */
const LEGACY_CPU = /core\s*2|athlon|phenom|amd fx-/i;

/** Family rows: the weakest member is the threshold a store row implies. */
const CPU_FAMILIES = [
  "core 2",
  "athlon 64 x2",
  "athlon ii x2",
  "athlon ii x3",
  "athlon ii x4",
  "athlon x2",
  "athlon x3",
  "athlon x4",
  "phenom ii x2",
  "phenom ii x3",
  "phenom ii x4",
  "phenom ii x6",
  "fx",
];

function addFamilyScores(map) {
  for (const family of CPU_FAMILIES) {
    const members = [...map.values()].filter((row) => row.key.startsWith(`${family} `));
    if (members.length === 0) continue;
    map.set(family, {
      key: family,
      score: Math.min(...members.map((row) => row.score)),
      count: 0,
    });
  }
}

function bestByKey(map, key, score, count, minCount = 3) {
  if (!score || count < minCount) return;
  const previous = map.get(key);
  if (!previous || count > previous.count || (count === previous.count && score > previous.score)) {
    map.set(key, { key, score: Math.round(score), count });
  }
}

const response = await fetch(QUERY);
if (!response.ok) throw new Error(`Blender Open Data returned HTTP ${response.status}`);
const payload = await response.json();
const rows = Array.isArray(payload.rows) ? payload.rows : [];
if (rows.length === 0) throw new Error("Blender Open Data returned no rows");

const gpus = new Map();
const cpus = new Map();
for (const [name, score, count] of rows) {
  const device = String(name);
  if (isGpu(device)) {
    for (const key of gpuKeys(device)) bestByKey(gpus, key, Number(score), Number(count));
  } else if (isCpu(device)) {
    const minCount = LEGACY_CPU.test(device) ? 1 : 3;
    for (const key of cpuKeys(device)) bestByKey(cpus, key, Number(score), Number(count), minCount);
  }
}
addFamilyScores(cpus);

const sortByKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const table = {
  source: "Blender Open Data (CC0)",
  sourceUrl: "https://opendata.blender.org",
  snapshot: new Date().toISOString().slice(0, 10),
  gpus: [...gpus.values()]
    .map(({ key, score }) => ({ key, score }))
    .sort(sortByKey),
  cpus: [...cpus.values()]
    .map(({ key, score }) => ({ key, score }))
    .sort(sortByKey),
};

writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`, "utf8");
console.log(`wrote ${OUT}: ${table.gpus.length} GPUs, ${table.cpus.length} CPUs`);
