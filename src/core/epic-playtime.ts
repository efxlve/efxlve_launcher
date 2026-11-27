/**
 * Server-side Epic playtime sync.
 *
 * The launcher records the sessions it started, but hours played anywhere else
 * live on Epic's servers. The library service answers the launcher token we
 * already store, so merging that snapshot gives real totals on library cards
 * and the profile. Local values are never lowered (manual edits and offline
 * sessions win).
 */

import { epicGetPlaytimes, epicSyncEpicPlaytimes } from "../epic";
import { isTauri } from "./constants";
import { scheduleRender } from "./render";
import { S } from "./state";

/** Drops Epic-owned entries (keys without a `store::` prefix) from `S.playtimeMap`. */
export function clearEpicPlaytimesInMemory(): void {
  let removed = false;
  for (const key of [...S.playtimeMap.keys()]) {
    if (!key.includes("::")) {
      S.playtimeMap.delete(key);
      removed = true;
    }
  }
  if (removed) S.libraryDataRev++;
}

/**
 * Reloads the active Epic account's local playtimes from disk while keeping
 * other stores' entries (`steam::`, `gog::`, `custom::`, etc.) intact, then
 * merges the server playtime snapshot on top.
 */
export async function reloadEpicPlaytimes(forceServer = false): Promise<void> {
  if (!isTauri) return;
  try {
    const local = await epicGetPlaytimes();
    clearEpicPlaytimesInMemory();
    for (const [key, rec] of Object.entries(local)) {
      if (!key.includes("::") || !S.playtimeMap.has(key)) {
        S.playtimeMap.set(key, rec);
      }
    }
    S.libraryDataRev++;
    scheduleRender();
  } catch (err) {
    console.warn("Epic local playtime reload failed:", err);
  }
  await syncEpicServerPlaytimes(forceServer);
}

/** Merges a server snapshot into `S.playtimeMap`; returns true when it changed. */
export function mergeEpicServerPlaytimes(server: Record<string, number>): boolean {
  let changed = false;
  for (const [appName, seconds] of Object.entries(server)) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    // The snapshot also lists Unreal Engine assets and plugins; keep games only.
    if (!S.epicSummariesMap.has(appName)) continue;
    const rec = S.playtimeMap.get(appName);
    if (!rec) {
      S.playtimeMap.set(appName, { total_seconds: seconds, session_count: 0 });
      changed = true;
    } else if (seconds > (rec.total_seconds || 0)) {
      rec.total_seconds = seconds;
      changed = true;
    }
  }
  // Playtime feeds the default/played sorts, so the library cache must miss.
  if (changed) S.libraryDataRev++;
  return changed;
}

/**
 * Fetches the Epic snapshot and repaints when something changed. `force`
 * skips the backend cache and is used right after a game session ends.
 */
export async function syncEpicServerPlaytimes(force = false): Promise<void> {
  if (!isTauri || S.offlineMode) return;
  try {
    const server = await epicSyncEpicPlaytimes(force);
    if (mergeEpicServerPlaytimes(server)) scheduleRender();
  } catch (err) {
    // Offline or an expired session: keep the locally tracked numbers.
    console.warn("Epic playtime sync failed:", err);
  }
}
