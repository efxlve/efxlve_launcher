/**
 * Steam library hydration.
 *
 * Two sources feed the same list:
 *   * games installed by the Steam client on this PC (local manifests), and
 *   * every owned game read through the signed-in Steam account
 *     (`IPlayerService/GetOwnedGames`), not-installed ones included.
 *
 * Steam owns the games: the launcher only reads metadata for the library grid
 * and hands every action back through the `steam://` protocol.
 */

import { setSteamSummaries } from "../../core/selectors";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import type { LibraryItem } from "../../core/types";
import {
  steamListInstalled,
  steamLoginStatus,
  steamOwnedGames,
  steamStatus,
  steamSyncPlaytime,
  type SteamGame,
  type SteamOwnedGame,
  type SteamPlaytime,
} from "../../steam";

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

/** Maps one owned-but-not-installed game: the "Install" action opens Steam. */
export function steamOwnedGameToItem(g: SteamOwnedGame): LibraryItem {
  return {
    key: `steam::${g.appId}`,
    source: "steam",
    id: g.appId,
    title: g.name || g.appId,
    developer: "",
    version: "—",
    installedVersion: null,
    installed: false,
    installPath: null,
    installSize: 0,
    coverUrl: `${STEAM_CDN}/${g.appId}/library_600x900.jpg`,
    heroUrl: `${STEAM_CDN}/${g.appId}/library_hero.jpg`,
    description: "",
    updateAvailable: false,
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

/** Server playtime (minutes) never lowers a locally measured value. */
function mergeOwnedPlaytimes(owned: SteamOwnedGame[]): void {
  for (const g of owned) {
    if (g.playtimeForever <= 0) continue;
    const key = `steam::${g.appId}`;
    const existing = S.playtimeMap.get(key);
    const seconds = g.playtimeForever * 60;
    if (existing && (existing.total_seconds || 0) >= seconds) continue;
    S.playtimeMap.set(key, {
      total_seconds: seconds,
      session_count: existing?.session_count ?? 0,
      last_played_timestamp: existing?.last_played_timestamp,
    });
  }
}

/** Refreshes the detected client status (Accounts card and Settings). */
export async function refreshSteamStatus(): Promise<void> {
  try {
    S.steamStatus = await steamStatus();
  } catch {
    // Keep the last known status.
  }
}

/**
 * Reads installed games, the owned library (when signed in) and playtime, then
 * repaints. Installed manifests paint first; the owned library (network) merges
 * in behind them, so a slow or offline connection never hides local games.
 *
 * Returns the owned-library error message (or `null`), so the caller can react
 * to an expired session.
 */
export async function loadSteamLibrary(): Promise<string | null> {
  S.steamLibrarySyncing = true;
  // The boot hydration may not have finished yet; one cheap status check keeps
  // the owned fetch from being skipped (no network while no login is pending).
  if (S.steamAuth === null) {
    try {
      S.steamAuth = await steamLoginStatus();
    } catch {
      // Stay signed out.
    }
  }
  let installed: SteamGame[];
  try {
    const [games, playtimes, status] = await Promise.all([
      steamListInstalled(),
      steamSyncPlaytime(),
      // The client status also feeds the Accounts page.
      steamStatus().catch(() => null),
    ]);
    installed = games;
    S.steamGames = games;
    S.steamStatus = status;
    mergeSteamPlaytimes(playtimes);
    setSteamSummaries(games.map(steamGameToItem));
  } catch {
    S.steamLibrarySyncing = false;
    setSteamSummaries([]);
    scheduleRender();
    return null;
  }
  scheduleRender();

  if (S.steamAuth?.state !== "signed_in") {
    S.steamOwnedCount = 0;
    S.steamLibrarySyncing = false;
    return null;
  }

  let error: string | null = null;
  try {
    const result = await steamOwnedGames();
    S.steamOwnedCount = result.gameCount;
    mergeOwnedPlaytimes(result.games);
    const installedIds = new Set(installed.map((g) => g.appId));
    const items = installed.map(steamGameToItem);
    for (const g of result.games) {
      if (!installedIds.has(g.appId)) items.push(steamOwnedGameToItem(g));
    }
    setSteamSummaries(items);
  } catch (e) {
    // Offline or an expired session: installed games stay on screen.
    error = String(e);
  } finally {
    S.steamLibrarySyncing = false;
  }
  scheduleRender();
  return error;
}
