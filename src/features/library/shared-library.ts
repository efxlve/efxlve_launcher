/**
 * Shared library index (Steam family-sharing style).
 *
 * Every saved account keeps a library snapshot on disk, so the launcher can show
 * the union of all accounts' games without any network access. Games owned by the
 * active account stay in the normal library; this module only adds the extra ones
 * together with their owner, and offers a one-click switch to that owner.
 */

import { sharedLibraryIndex, type EpicSummary } from "../../epic";
import { S } from "../../core/state";
import { rebuildAllGamesMap, sharedToSummary } from "../../core/selectors";
import { scheduleRender } from "../../core/render";

/** Reloads the index from disk snapshots (cheap; no network). */
export async function loadSharedLibrary(): Promise<void> {
  try {
    const index = await sharedLibraryIndex();
    S.sharedOwners = new Map(index.games.map((g) => [g.key, g]));
  } catch {
    S.sharedOwners.clear();
  }
  // Keep the unified lookup map and the visible grid in sync with the index.
  rebuildAllGamesMap();
  S.libraryDataRev++;
  scheduleRender();
}

/** Summaries for the library grid (empty while the setting is off). */
export function sharedSummaries(): EpicSummary[] {
  if (!S.showSharedLibrary) return [];
  return Array.from(S.sharedOwners.values()).map(sharedToSummary);
}
