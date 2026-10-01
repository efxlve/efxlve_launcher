/**
 * Loads installed EA, Ubisoft, Xbox and Battle.net games into the shared library.
 */

import { rebuildAllGamesMap } from "../../core/selectors";
import { S } from "../../core/state";
import { companionInstalledGames, companionToItem } from "../../companion";

export async function loadCompanionLibrary(): Promise<void> {
  try {
    const games = await companionInstalledGames();
    S.companionSummaries = games.map(companionToItem);
  } catch {
    S.companionSummaries = [];
  }
  rebuildAllGamesMap();
}
