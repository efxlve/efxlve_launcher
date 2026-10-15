/**
 * Which built chunk carries which feature module.
 *
 * Run after `npm run build`:
 *   node scripts/chunk-report.mjs
 *
 * Each feature is probed with a string that only appears in its own source, so
 * the table says exactly what to split next when the boot bundle grows.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("dist", "assets");
const probes = [
  ["overlay", "ov-widget-"],
  ["settings", "settings-section"],
  ["drawer", "drawer-tab-content"],
  ["library", "lib-page-size"],
  ["store", "store-tabs-bar"],
  ["discord", "ov-discord-search"],
  ["music", "sb-mini-"],
  ["tv-mode", "tv-search-chip"],
  ["downloads", "speed-canvas"],
  ["screenshots", "screenshot-card"],
  ["notes", "notes-search"],
  ["igdb", "igdb_status"],
  ["task-manager", "tm-stats"],
  ["profile", "profile-presence-text"],
  ["accounts", "account-switch"],
  ["collections", "col-merge-panel"],
  ["palette", "palette-root"],
  ["storage", "storage-search-input"],
  ["changelog", "changelog-body"],
];

const chunks = readdirSync(dir).filter((name) => name.endsWith(".js"));
const rows = [];
for (const name of chunks) {
  const text = readFileSync(join(dir, name), "utf8");
  const found = probes.filter(([, needle]) => text.includes(needle)).map(([label]) => label);
  const size = Math.round(text.length / 1024);
  rows.push({ name, size, found });
}
rows.sort((a, b) => b.size - a.size);
for (const row of rows) {
  if (row.size < 20) continue;
  console.log(`${String(row.size).padStart(5)} KB  ${row.name.padEnd(34)} ${row.found.join(", ")}`);
}
