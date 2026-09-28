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
import { sharedToSummary } from "../../core/selectors";
import { switchAccount } from "../auth/account-switcher";
import { switchGogAccount } from "../auth/gog-account-switcher";

/** Reloads the index from disk snapshots (cheap; no network). */
export async function loadSharedLibrary(): Promise<void> {
  try {
    const index = await sharedLibraryIndex();
    S.sharedLibrary = index;
    S.sharedOwners = new Map(index.games.map((g) => [g.key, g]));
  } catch {
    S.sharedLibrary = null;
    S.sharedOwners.clear();
  }
  S.libraryDataRev++;
}

/** Summaries for the library grid (empty while the setting is off). */
export function sharedSummaries(): EpicSummary[] {
  if (!S.showSharedLibrary) return [];
  return Array.from(S.sharedOwners.values()).map(sharedToSummary);
}

/** Switches to the account that owns a shared game (`epic:<id>` / `gog:<id>`). */
export async function switchToSharedOwner(ownerKey: string): Promise<void> {
  const [store, id] = ownerKey.split(":");
  if (!id) return;
  if (store === "epic") {
    await switchAccount(id);
  } else if (store === "gog") {
    await switchGogAccount(id);
  }
  // The switched-to account now owns the game, so the index shrinks by one.
  await loadSharedLibrary();
}
