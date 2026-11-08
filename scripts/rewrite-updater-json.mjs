// Rewrites the updater feed's API asset URLs to the public release download
// URLs. tauri-action writes api.github.com asset links into latest.json; those
// links need an Accept: application/octet-stream header and can 404 behind a
// proxy or after a release asset is replaced. The release download URL is
// stable and works with a plain GET.
//
// Usage: node scripts/rewrite-updater-json.mjs <version> <latest.json>
// In GitHub Actions, GITHUB_REPOSITORY and GITHUB_TOKEN come from the env.

import { readFile, writeFile } from "node:fs/promises";

const [version, file] = process.argv.slice(2);
if (!version || !file) {
  console.error("usage: node scripts/rewrite-updater-json.mjs <version> <latest.json>");
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || "efxlve/efxlve_launcher";
// Actions exports the workflow token as GH_TOKEN in the release job; allow the
// conventional GITHUB_TOKEN name too for local runs and other workflows.
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (token) headers.Authorization = `Bearer ${token}`;

// The tag endpoint does not return draft releases for every token, and the
// release is still a draft while this script runs. Fall back to the list.
const response = await fetch(
  `https://api.github.com/repos/${repo}/releases/tags/v${version}`,
  { headers },
);
let release = null;
if (response.ok) {
  release = await response.json();
} else {
  const listResponse = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    { headers },
  );
  if (!listResponse.ok) {
    throw new Error(`release v${version} lookup failed: ${listResponse.status} ${listResponse.statusText}`);
  }
  const releases = await listResponse.json();
  release = releases.find((entry) => entry.tag_name === `v${version}`) ?? null;
  if (!release) {
    throw new Error(`release v${version} lookup failed: ${response.status} ${response.statusText}`);
  }
}
// Draft releases report `browser_download_url` with an `untagged-...` path that
// changes when the draft is published. The tag path is stable, so build it from
// the tag and the asset name.
const downloadBase = `https://github.com/${repo}/releases/download/v${version}`;
const byId = new Map(
  (release.assets ?? []).map((asset) => [asset.id, `${downloadBase}/${encodeURIComponent(asset.name)}`]),
);

const feed = JSON.parse(await readFile(file, "utf8"));
const platforms = Object.values(feed.platforms ?? {});
if (platforms.length === 0) throw new Error("latest.json has no platforms");

let rewritten = 0;
let unmapped = 0;
for (const entry of platforms) {
  if (typeof entry.url !== "string") continue;
  const match = /\/releases\/assets\/(\d+)\/?$/.exec(entry.url);
  if (!match) continue; // already a download URL or a custom host
  const downloadUrl = byId.get(Number(match[1]));
  if (!downloadUrl) {
    unmapped += 1;
    continue;
  }
  entry.url = downloadUrl;
  rewritten += 1;
}

if (unmapped > 0) {
  throw new Error(`${unmapped} asset URL(s) did not match an asset on v${version}`);
}

await writeFile(file, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
console.log(`rewrote ${rewritten} updater URL(s) to release download URLs`);
