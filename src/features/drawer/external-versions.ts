/**
 * Store labels for the game page version selector (Epic / GOG / Steam).
 */

import type { GameVersionSource } from "../../core/selectors";

/** Brand label for one store version in the game page selector. */
export function storeVersionLabel(source: GameVersionSource): string {
  switch (source) {
    case "gog":
      return "GOG";
    case "steam":
      return "Steam";
    case "ea":
      return "EA App";
    case "ubisoft":
      return "Ubisoft Connect";
    case "xbox":
      return "Xbox";
    case "battlenet":
      return "Battle.net";
    case "riot":
      return "Riot Games";
    default:
      return "Epic Games";
  }
}
