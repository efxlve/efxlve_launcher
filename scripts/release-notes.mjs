// Builds a GitHub release body straight from the in-app changelog, so the
// release page and the app's "What's new" never drift apart.
//
// Usage (from the repo root, after the tag has published):
//   node scripts/release-notes.mjs 0.1.28 "$env:TEMP\notes.md"
//   gh release edit v0.1.28 --notes-file "$env:TEMP\notes.md"
//
// The workflow's `releaseBody` is only a placeholder: this replaces it.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
const out = process.argv[3];
if (!version || !out) {
  console.error("usage: node scripts/release-notes.mjs <version> <out.md>");
  process.exit(1);
}

const src = readFileSync("src/features/changelog/changelog-view.ts", "utf8");
const start = src.indexOf(`version: "${version}"`);
if (start < 0) throw new Error(`version ${version} not found in the changelog`);
const next = src.indexOf('version: "', start + 1);
const block = src.slice(start, next < 0 ? undefined : next);

// The entry holds two lists: `items` (new) first, then `fixed`.
const fixedAt = block.indexOf("fixed: [");
if (fixedAt < 0) throw new Error(`no fixed list for ${version}`);
const newPart = block.slice(0, fixedAt);
const fixedPart = block.slice(fixedAt);

const enStrings = (part) =>
  [...part.matchAll(/\ben:\s*("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]));

const items = enStrings(newPart);
const fixed = enStrings(fixedPart);

const body = [
  `## ${version}`,
  "",
  "**New**",
  "",
  ...items.map((line) => `- ${line}`),
  "",
  "**Fixed**",
  "",
  ...fixed.map((line) => `- ${line}`),
  "",
].join("\n");

writeFileSync(out, body, "utf8");
console.log(`new=${items.length} fixed=${fixed.length} chars=${body.length}`);
