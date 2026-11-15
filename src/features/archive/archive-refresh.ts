/**
 * Reloads the library that owns a game after a disc restore rewrote its store
 * record. Loaded on demand so the archive UI does not pull these modules into
 * its own import cycle.
 */

import { refreshEpicInstalled } from "../../core/epic-actions";
import { refreshSteamInstalled } from "../library/steam-library";
import { syncGogLibrary } from "../auth/gog-auth-actions";
import { loadAmazonSession } from "../auth/amazon-auth-actions";
import { loadCustomGamesLibrary } from "../custom-games/custom-games-library";
import { loadCompanionLibrary } from "../library/companion-library";

export async function refreshAfterRestore(store: string): Promise<void> {
  try {
    if (store === "steam") {
      await refreshSteamInstalled();
    } else if (store === "epic") {
      await refreshEpicInstalled();
    } else if (store === "gog") {
      await syncGogLibrary(false);
    } else if (store === "amazon") {
      await loadAmazonSession(false);
    } else if (store === "custom") {
      await loadCustomGamesLibrary();
    } else {
      await loadCompanionLibrary();
    }
  } catch {
    // The files and the store record are already in place.
  }
}
