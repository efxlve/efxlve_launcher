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

const enStrings = (part) =>
  [...part.matchAll(/\ben:\s*("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]));

const keys = ["items", "added", "improved", "fixed"];
const section = (key) => {
  const at = block.indexOf(`${key}: [`);
  if (at < 0) return [];
  const after = block.slice(at);
  const next = keys
    .map((candidate) => after.indexOf(`${candidate}: [`))
    .filter((offset) => offset > 0)
    .sort((a, b) => a - b)[0];
  return enStrings(next ? after.slice(0, next) : after);
};

const sections = [
  ["New", section("items")],
  ["Added", section("added")],
  ["Improved", section("improved")],
  ["Fixed", section("fixed")],
].filter(([, lines]) => lines.length > 0);

const body = [
  `## ${version}`,
  "",
  ...sections.flatMap(([title, lines]) => [`**${title}**`, "", ...lines.map((line) => `- ${line}`), ""]),
].join("\n");

writeFileSync(out, body, "utf8");
const counts = sections.map(([title, lines]) => `${title.toLowerCase()}=${lines.length}`).join(" ");
console.log(`${counts} chars=${body.length}`);
