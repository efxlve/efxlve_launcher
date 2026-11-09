/**
 * Reclaims localStorage space from custom covers, heroes and logos.
 *
 * Older builds stored the picked file as a full-size data URL. Those records
 * can fill the origin quota, so a new cover is rejected even though the file
 * itself was already downscaled. This pass re-encodes every oversized stored
 * image at a smaller size and writes each record once, after all of its images
 * fit, which keeps a failed write from leaving a half-compacted record.
 */

import { CUSTOM_COVERS_KEY, CUSTOM_HEROES_KEY, CUSTOM_LOGOS_KEY } from "../../core/constants";
import { S } from "../../core/state";
import { shrinkStoredArt, type CoverFileTarget } from "./cover-file";

/** Start compacting above this many characters; a browser quota is ~5M. */
const STORAGE_PRESSURE_CHARS = 3_200_000;

/** Stricter per-image budget used while freeing space. */
const COMPACT_CHARS: Record<CoverFileTarget, number> = {
  cover: 90_000,
  hero: 180_000,
  logo: 90_000,
};

/** A rejected save squeezes harder, because the origin is already full. */
const FORCE_CHARS: Record<CoverFileTarget, number> = {
  cover: 45_000,
  hero: 90_000,
  logo: 45_000,
};

const RECORDS: readonly { key: string; target: CoverFileTarget; record: () => Record<string, string> }[] = [
  { key: CUSTOM_COVERS_KEY, target: "cover", record: () => S.customCovers },
  { key: CUSTOM_HEROES_KEY, target: "hero", record: () => S.customHeroes },
  { key: CUSTOM_LOGOS_KEY, target: "logo", record: () => S.customLogos },
];

/** Characters currently held by the whole origin, keys included. */
function storageChars(): number {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    total += key.length + (localStorage.getItem(key)?.length ?? 0);
  }
  return total;
}

let running: Promise<void> | null = null;

/** True when a reset or another writer did not touch the record mid-compaction. */
function unchanged(snapshot: Record<string, string>, live: Record<string, string>): boolean {
  const keys = Object.keys(snapshot);
  if (keys.length !== Object.keys(live).length) return false;
  return keys.every((key) => snapshot[key] === live[key]);
}

async function compactRecord(
  key: string,
  target: CoverFileTarget,
  record: Record<string, string>,
  force: boolean,
): Promise<boolean> {
  const original = { ...record };
  const next = { ...record };
  const limit = force ? FORCE_CHARS[target] : COMPACT_CHARS[target];
  let changed = false;
  for (const [appName, value] of Object.entries(next)) {
    if (typeof value !== "string" || !value.startsWith("data:image/") || value.length <= limit) continue;
    try {
      const shrunk = await shrinkStoredArt(value, target, limit);
      if (shrunk.length < value.length) {
        next[appName] = shrunk;
        changed = true;
      }
    } catch {
      // A broken legacy image must not stop the other records from shrinking.
    }
  }
  if (!changed) return false;
  // A reset can run while the images are decoding; writing this snapshot then
  // would put the removed entry back. Skip it and let the next pass retry.
  if (!unchanged(original, record)) return false;
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    return false;
  }
  // Only expose the compacted values after the write succeeded.
  for (const [appName, value] of Object.entries(next)) record[appName] = value;
  return true;
}

async function run(force: boolean): Promise<void> {
  try {
    if (!force && storageChars() < STORAGE_PRESSURE_CHARS) return;
  } catch {
    return;
  }
  for (const { key, target, record } of RECORDS) {
    await compactRecord(key, target, record(), force);
  }
}

/**
 * Shrinks oversized custom art. `force` runs the pass even below the pressure
 * threshold, which is what a rejected save does before retrying.
 */
export function compactCustomArtStorage(force = false): Promise<void> {
  if (running) return running;
  running = run(force).finally(() => {
    running = null;
  });
  return running;
}
