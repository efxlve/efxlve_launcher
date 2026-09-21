/**
 * O(1) lookups over the shared game state.
 *
 * The library can hold 500+ games, so every render must avoid linear array
 * scans. `setEpicSummaries` / `setEpicGamesRaw` keep synchronized hash maps in
 * `S`, and `summaryOf` / `rawOf` read them in constant time.
 */

import type { EpicGame, EpicSummary } from "../epic";
import { S } from "./state";

/** Replace the raw game list and rebuild its lookup map. */
export function setEpicGamesRaw(games: EpicGame[]): void {
  S.epicGamesRaw = games;
  S.epicGamesRawMap = new Map(games.map((g) => [g.app_name, g]));
}

/** Replace the parsed summary list and rebuild its lookup map. */
export function setEpicSummaries(sums: EpicSummary[]): void {
  S.epicSummaries = sums;
  S.epicSummariesMap = new Map(sums.map((s) => [s.appName, s]));
}

/** O(1) summary lookup by app name. */
export function summaryOf(appName: string): EpicSummary | undefined {
  return S.epicSummariesMap.get(appName);
}

/** O(1) raw metadata lookup by app name. */
export function rawOf(appName: string): EpicGame | undefined {
  return S.epicGamesRawMap.get(appName);
}
