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
    if (!measurable(game.path) || game.key.startsWith("steam::")) continue;
    let bytes = 0;
    try {
      bytes = await invoke<number>("storage_path_size", { path: game.path });
    } catch {
      bytes = 0;
    }
    if (shouldStop?.()) return changed;
    if (bytes <= 0) continue;
    S.measuredSizes.set(game.key, { bytes, at: Date.now() });
    scheduleSave();
    changed = true;
    onHit(game.key, bytes);
  }
  return changed;
}
