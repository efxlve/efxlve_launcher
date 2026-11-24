/**
 * Real on-disk folder sizes, measured in the background.
 *
 * Store metadata under-reports some installs (Epic reports Fortnite at a few
 * hundred MB while the folder holds tens of GB), so every size display prefers
 * the measured number. Measurements are shared through S.measuredSizes and
 * persisted to localStorage, and the Rust side caches each walk for five
 * minutes so the views can share the work.
 */

import { invoke } from "@tauri-apps/api/core";
import { FOLDER_SIZES_KEY } from "./constants";
import { S } from "./state";

/** A measurement stays fresh for this long; a later view re-measures it. */
const MEASURE_TTL = 10 * 60 * 1000;

/** Games with a folder walk already running, so a second view shares the result. */
const pendingSizes = new Map<string, Promise<number | null>>();

/** Fresh real folder size for a library key, or null when unknown. */
export function measuredSize(key: string): number | null {
  const hit = S.measuredSizes.get(key);
  return hit && Date.now() - hit.at < MEASURE_TTL ? hit.bytes : null;
}

/** A game folder worth walking: not empty and not a drive root. */
function measurable(path: string | null | undefined): path is string {
  if (!path || path.length < 4) return false;
  return !/^[a-zA-Z]:[\\/]?$/.test(path);
}

/**
 * Measures one game folder and stores the result for every view. Steam sizes
 * come from the client manifest, so they are skipped. A second caller joins the
 * walk already running instead of starting another. Resolves to the byte count,
 * or null when the path is unknown or unreadable.
 */
export function ensureMeasuredSize(
  key: string,
  path: string | null | undefined,
): Promise<number | null> {
  const hit = measuredSize(key);
  if (hit !== null) return Promise.resolve(hit);
  if (!measurable(path) || key.startsWith("steam::")) return Promise.resolve(null);
  const running = pendingSizes.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const bytes = await invoke<number>("storage_path_size", { path });
      if (bytes <= 0) return null;
      S.measuredSizes.set(key, { bytes, at: Date.now() });
      scheduleSave();
      return bytes;
    } catch {
      return null;
    }
  })().finally(() => pendingSizes.delete(key));
  pendingSizes.set(key, job);
  return job;
}

/** Persists the measurement map, coalescing bursts into one write. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const out: Record<string, [number, number]> = {};
      for (const [key, hit] of S.measuredSizes) out[key] = [hit.bytes, hit.at];
      localStorage.setItem(FOLDER_SIZES_KEY, JSON.stringify(out));
    } catch {
      // Persistence is best-effort; the session cache still works.
    }
  }, 2000);
}

/**
 * Measures folders one at a time and reports every hit. Steam folders are
 * skipped because their appmanifest size is already exact. `shouldStop` lets a
 * closed dialog cancel the loop; resolves to true when anything was measured.
 */
export async function measureFolders(
  games: { key: string; path: string | null }[],
  onHit: (key: string, bytes: number) => void,
  shouldStop?: () => boolean,
): Promise<boolean> {
  let changed = false;
  for (const game of games) {
    if (shouldStop?.()) return changed;
    if (measuredSize(game.key) !== null) continue;
    const bytes = await ensureMeasuredSize(game.key, game.path);
    if (shouldStop?.()) return changed;
    if (bytes === null) continue;
    changed = true;
    onHit(game.key, bytes);
  }
  return changed;
}
