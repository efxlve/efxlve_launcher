/**
 * Steam library hydration (games installed by the Steam client on this PC).
 *
 * Steam owns the games: the launcher only reads the client's manifests for the
 * library grid and hands every action back through the `steam://` protocol.
 */

import { setSteamSummaries } from "../../core/selectors";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import type { LibraryItem } from "../../core/types";
import { steamListInstalled, steamStatus, steamSyncPlaytime, type SteamGame, type SteamPlaytime } from "../../steam";

const STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";

/** Maps one manifest entry to a library item (a manifest means installed). */
export function steamGameToItem(g: SteamGame): LibraryItem {
  return {
    key: `steam::${g.appId}`,
    source: "steam",
    id: g.appId,
    title: g.name,
    developer: "",
    version: "—",
    installedVersion: null,
    installed: true,
    installPath: g.installDir ? `${g.library}\\common\\${g.installDir}` : g.library,
    installSize: g.sizeBytes,
    coverUrl: `${STEAM_CDN}/${g.appId}/library_600x900.jpg`,
    heroUrl: `${STEAM_CDN}/${g.appId}/library_hero.jpg`,
    description: "",
    // Steam sets bit 2 in StateFlags when an update is waiting.
    updateAvailable: (g.stateFlags & 2) !== 0,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}

/** Merges Steam's own playtime (seconds) without lowering local values. */
function mergeSteamPlaytimes(records: Record<string, SteamPlaytime>): void {
  for (const [appId, record] of Object.entries(records)) {
    if (!Number.isFinite(record.seconds) || record.seconds <= 0) continue;
    const key = `steam::${appId}`;
    const existing = S.playtimeMap.get(key);
    if (existing && (existing.total_seconds || 0) >= record.seconds) continue;
    S.playtimeMap.set(key, {
      total_seconds: record.seconds,
      session_count: existing?.session_count ?? 0,
      last_played_timestamp: record.lastPlayed ?? existing?.last_played_timestamp,
    });
  }
}

/** Reads the installed Steam games plus their playtime and repaints the library. */
export async function loadSteamLibrary(): Promise<void> {
  try {
    const [games, playtimes, status] = await Promise.all([
      steamListInstalled(),
      steamSyncPlaytime(),
      // The client status also feeds the Accounts page (no sign-in needed there).
      steamStatus().catch(() => null),
    ]);
    S.steamGames = games;
    S.steamStatus = status;
    mergeSteamPlaytimes(playtimes);
    setSteamSummaries(games.map(steamGameToItem));
  } catch {
    setSteamSummaries([]);
  }
  scheduleRender();
}
