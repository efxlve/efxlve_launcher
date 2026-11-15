/**
 * Pure game selection for the archive screen. Epic's manage panel passes the
 * bare app name (`Sugar`), while the unified library keys every game
 * (`epic::Sugar`).
 */

import type { LibraryItem } from "../../core/types";

/** Exact match only; `undefined` means the game is not installed or not known. */
export function findArchiveGame(
  games: LibraryItem[],
  appName: string,
): LibraryItem | undefined {
  return (
    games.find((game) => game.key === appName) ??
    games.find((game) => game.id === appName)
  );
}

/** Exact match, then the first installed game for the screen's initial state. */
export function pickArchiveGame(
  games: LibraryItem[],
  appName: string,
): LibraryItem | undefined {
  return findArchiveGame(games, appName) ?? (games.length ? games[0] : undefined);
}
