/**
 * Installed-game process watch for the stores that do not report themselves.
 *
 * Steam has its own registry flag (`steam_watch_running`); every other store is
 * watched by folder: the Rust side checks whether one of a game's executables is
 * open, so a game started from its own client (or a shortcut) still shows as
 * Running and lands in Recently played.
 */

import { isTauri } from "../../core/constants";
import { S } from "../../core/state";
import { gameWatchInstalled } from "../../game-watch";

let lastSignature = "";

function installedGames(): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const push = (id: string, path: string | null | undefined): void => {
    if (!id || !path || id.startsWith("steam::")) return;
    out.push({ id, path });
  };
  for (const s of S.epicSummaries) if (s.installed) push(s.appName, s.installPath);
  for (const g of S.gogSummaries) if (g.installed) push(g.key, g.installPath);
  for (const g of S.amazonSummaries) if (g.installed) push(g.key, g.installPath);
  for (const g of S.companionSummaries) if (g.installed) push(g.key, g.installPath);
  return out;
}

/** Pushes the installed list to the watcher whenever it changed. */
export function syncInstalledWatch(): void {
  if (!isTauri) return;
  const list = installedGames();
  const signature = list.map((g) => `${g.id}\u001f${g.path}`).join("\u001e");
  if (signature === lastSignature) return;
  lastSignature = signature;
  void gameWatchInstalled(list).catch(() => {});
}
