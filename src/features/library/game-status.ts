/** Reads and writes the per-game status map in shared state. */

import { saveGameStatus, type GameStatus } from "../../core/game-status";
import { S } from "../../core/state";

export type { GameStatus };

export function gameStatusOf(appName: string): GameStatus | undefined {
  return S.gameStatus.get(appName);
}

export function setGameStatus(appName: string, status: GameStatus | null): void {
  if (status) S.gameStatus.set(appName, status);
  else S.gameStatus.delete(appName);
  saveGameStatus(S.gameStatus);
  // Smart collections and the status menu read this map: the library's visible
  // cache must miss after a change, not only when the page is rebuilt.
  S.libraryDataRev++;
}
