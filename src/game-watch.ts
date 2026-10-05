/**
 * Bridge for the installed-game process watcher.
 *
 * Steam reports itself through its own registry flag; every other store is
 * watched by install folder, so games started from their own client still show
 * as Running.
 */

import { invoke } from "@tauri-apps/api/core";

export interface InstalledWatchGame {
  id: string;
  path: string;
}

/** Replaces the watcher's installed-game list. */
export const gameWatchInstalled = (games: InstalledWatchGame[]) =>
  invoke<void>("game_watch_installed", { games });
