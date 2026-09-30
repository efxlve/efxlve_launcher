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

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { setSteamSummaries } from "../../core/selectors";
import { notify, openEpicModal, scheduleRender } from "../../core/render";
import { updateBadge } from "../../core/nav";
import { patchLibraryCardDom } from "../../core/game-view";
import { S } from "../../core/state";
import type { LibraryItem } from "../../core/types";
import { localizeMessage, t } from "../../i18n";
import { fmtBytes } from "../../core/utils";
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

const STEAM_CAT_CLOUD = 23;

function steamCloudFlag(appId: string): boolean {
  return Boolean(S.steamDetails.get(`steam::${appId}`)?.categories.includes(STEAM_CAT_CLOUD));
}

const STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";

/** Steamworks SDK / runtimes that are not playable titles. */
const STEAM_TOOL_IDS = new Set(["228980"]);

const STEAM_STATE_UPDATE_REQUIRED = 2;
const STEAM_STATE_UPDATE_RUNNING = 256;
const STEAM_STATE_UPDATE_STARTED = 1024;

/** True when Steam reports a pending store update, not a leftover mid-patch ACF. */
export function steamUpdatePending(stateFlags: number): boolean {
  return (stateFlags & STEAM_STATE_UPDATE_REQUIRED) !== 0
    && (stateFlags & STEAM_STATE_UPDATE_RUNNING) === 0
    && (stateFlags & STEAM_STATE_UPDATE_STARTED) === 0;
}

export function isSteamLibraryNoise(appId: string, name = ""): boolean {
  if (STEAM_TOOL_IDS.has(appId)) return true;
  const n = name.toLowerCase();
  return n.includes("steamworks common redistributables")
    || n.includes("steamworks redistributable")
    || n.startsWith("steam linux runtime")
    || n.startsWith("proton ")
    || n === "proton experimental"
    || n.includes("steamworks sdk")
    || n === "source sdk"
    || n.startsWith("source sdk ");
}

/** One visible report per run when the owned list cannot be fetched. */
let ownedErrorNotified = false;

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
    // Bit 2 = update required. Bits 256/1024 mean a download already started
    // (or was left behind after Steam quit) and must not look like a store update.
    updateAvailable: steamUpdatePending(g.stateFlags),
    downloading: g.downloading,
    bytesDownloaded: g.bytesDownloaded,
    bytesToDownload: g.bytesToDownload,
    cloudSavesSupported: steamCloudFlag(g.appId),
    dlcCount: S.steamDetails.get(`steam::${g.appId}`)?.dlc.length ?? 0,
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
    cloudSavesSupported: steamCloudFlag(g.appId),
    dlcCount: S.steamDetails.get(`steam::${g.appId}`)?.dlc.length ?? 0,
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
    installed = games.filter((g) => !isSteamLibraryNoise(g.appId, g.name));
    S.steamGames = installed;
    S.steamStatus = status;
    mergeSteamPlaytimes(playtimes);
    setSteamSummaries(games.filter((g) => !isSteamLibraryNoise(g.appId, g.name)).map(steamGameToItem));
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
    const items = installed.filter((g) => !isSteamLibraryNoise(g.appId, g.name)).map(steamGameToItem);
    for (const g of result.games) {
      if (installedIds.has(g.appId) || isSteamLibraryNoise(g.appId, g.name)) continue;
      items.push(steamOwnedGameToItem(g));
    }
    setSteamSummaries(items);
  } catch (e) {
    // Offline or an expired session: installed games stay on screen, but a
    // failure must not make a signed-in Steam library look empty.
    error = String(e);
    if (!ownedErrorNotified && error !== "@t:steam.err.notSignedIn") {
      ownedErrorNotified = true;
      notify({ kind: "error", title: t("steam.libraryErrorTitle"), body: localizeMessage(error) });
    }
  } finally {
    S.steamLibrarySyncing = false;
  }
  scheduleRender();
  return error;
}

/**
 * One-shot resync after an action was handed to the Steam client. Steam creates
 * the download folder or drops the manifest a few seconds after the hand-off,
 * so the grid is re-read once; a single timer keeps the idle launcher free of
 * polling (the client stays the source of truth for progress).
 */
let steamResyncTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSteamLibraryResync(delayMs = 6000): void {
  if (steamResyncTimer !== null) clearTimeout(steamResyncTimer);
  steamResyncTimer = setTimeout(() => {
    steamResyncTimer = null;
    void loadSteamLibrary();
  }, delayMs);
}

/** Applies a fresh installed/downloading snapshot without hitting the owned-games API. */
export function applySteamInstalledSnapshot(games: SteamGame[]): boolean {
  S.steamGames = games.filter((g) => !isSteamLibraryNoise(g.appId, g.name));
  const byId = new Map(S.steamGames.map((g) => [g.appId, g]));
  let changed = false;
  let structural = false;
  const next: LibraryItem[] = [];
  const seen = new Set<string>();

  for (const item of S.steamSummaries) {
    if (isSteamLibraryNoise(item.id, item.title)) {
      changed = true;
      structural = true;
      continue;
    }
    seen.add(item.id);
    const g = byId.get(item.id);
    if (!g) {
      if (item.installed || item.downloading) {
        changed = true;
        structural = true;
        next.push({ ...item, installed: false, downloading: false, updateAvailable: false, bytesDownloaded: 0, bytesToDownload: 0 });
      } else {
        next.push(item);
      }
      continue;
    }
    const updateAvailable = steamUpdatePending(g.stateFlags);
    const downloading = g.downloading;
    const installed = g.installDir.length > 0 || (g.stateFlags & 4) !== 0;
    const titleChanged = !/^\d+$/.test(g.name) && item.title !== g.name;
    const sizeChanged = g.sizeBytes > 0 && item.installSize !== g.sizeBytes;
    const stateChanged = item.installed !== installed
      || item.downloading !== downloading
      || item.updateAvailable !== updateAvailable
      || sizeChanged
      || titleChanged;
    const bytesChanged = item.bytesDownloaded !== g.bytesDownloaded
      || item.bytesToDownload !== g.bytesToDownload;
    if (stateChanged || bytesChanged) {
      if (!item.updateAvailable && updateAvailable) {
        notify({ kind: "update", title: t("notif.updateAvailable", { title: item.title }), appName: item.key });
      }
      changed = true;
      if (stateChanged) structural = true;
      next.push({
        ...item,
        installed,
        downloading,
        bytesDownloaded: g.bytesDownloaded,
        bytesToDownload: g.bytesToDownload,
        updateAvailable,
        installSize: g.sizeBytes || item.installSize,
        title: /^\d+$/.test(g.name) ? item.title : g.name,
      });
    } else {
      next.push(item);
    }
  }

  for (const g of S.steamGames) {
    if (seen.has(g.appId)) continue;
    if (g.downloading && /^\d+$/.test(g.name)) continue;
    next.push(steamGameToItem(g));
    changed = true;
    structural = true;
  }

  if (!changed) return false;
  setSteamSummaries(next);
  updateBadge();
  if (structural) {
    scheduleRender();
    if (S.currentModalAppName?.startsWith("steam::")) {
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else {
    for (const g of games) {
      if (!g.downloading) continue;
      const id = `steam::${g.appId}`;
      patchLibraryCardDom(id);
      const pct = g.bytesToDownload > 0
        ? Math.min(100, Math.round((g.bytesDownloaded / g.bytesToDownload) * 100))
        : null;
      const label = pct !== null ? t("common.downloading", { p: pct }) : t("steam.downloading");
      document.querySelectorAll(`[data-dlbtn="${id}"]`).forEach((el) => {
        el.textContent = label;
      });
      const meta = document.querySelector(`[data-steam-dl="${g.appId}"]`);
      if (meta) {
        const bytes = g.bytesDownloaded > 0
          ? `${fmtBytes(g.bytesDownloaded)}${g.bytesToDownload > 0 ? ` / ${fmtBytes(g.bytesToDownload)}` : ""}`
          : "";
        meta.textContent = [pct !== null ? `%${pct}` : "", bytes].filter(Boolean).join(" · ") || t("steam.downloadingHint");
      }
    }
  }
  return true;
}

/** Re-reads local Steam manifests after the client writes an update or download. */
export async function refreshSteamInstalled(): Promise<void> {
  try {
    applySteamInstalledSnapshot(await steamListInstalled());
  } catch {
    // Keep the last snapshot.
  }
}

export function startSteamLibraryWatch(): void {
  if (!isTauri) return;
  void invoke("steam_watch_library").catch(() => {});
}
