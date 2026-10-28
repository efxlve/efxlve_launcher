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
  return /intel core|amd ryzen|threadripper/i.test(name);
}

function bestByKey(map, key, score, count) {
  if (!score || count < 3) return;
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
    for (const key of cpuKeys(device)) bestByKey(cpus, key, Number(score), Number(count));
  }
}

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
