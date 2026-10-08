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
import { pushRecent, pushRecentInstall } from "../../core/recent";
import { setSteamSummaries } from "../../core/selectors";
import { notify, openEpicModal, scheduleRender } from "../../core/render";
import { updateBadge } from "../../core/nav";
import { patchLibraryCardDom } from "../../core/game-view";
import { S } from "../../core/state";
import type { LibraryItem } from "../../core/types";
import { localizeMessage, t } from "../../i18n";
import { fmtBytes } from "../../core/utils";
import {
  steamAppMetadata,
  steamDownloadLive,
  steamListInstalled,
  steamLoginStatus,
  steamOwnedGames,
  steamStatus,
  steamSyncPlaytime,
  steamWatchRunning,
  type SteamAppMetadata,
  type SteamGame,
  type SteamOwnedGame,
  type SteamPlaytime,
} from "../../steam";

const STEAM_CAT_CLOUD = 23;

function steamCloudFlag(appId: string): boolean {
  return Boolean(S.steamDetails.get(`steam::${appId}`)?.categories.includes(STEAM_CAT_CLOUD));
}

const STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps";

/** App id → client-cached metadata, hydrated from `appinfo.vdf`. */
const steamMeta = new Map<string, SteamAppMetadata>();

/** Replaces the cached client metadata with a fresh appinfo read. */
function setSteamMetadata(map: Record<string, SteamAppMetadata>): void {
  steamMeta.clear();
  for (const [appId, meta] of Object.entries(map)) {
    if (meta && (meta.developer || (meta.genres && meta.genres.length) || meta.releaseYear)) {
      steamMeta.set(appId, meta);
    }
  }
}

function steamDeveloper(appId: string): string {
  return steamMeta.get(appId)?.developer?.trim() ?? "";
}

function steamGenres(appId: string): string[] {
  return steamMeta.get(appId)?.genres ?? [];
}

function steamReleaseYear(appId: string): number | null {
  return steamMeta.get(appId)?.releaseYear ?? null;
}

/** Steamworks SDK / runtimes that are not playable titles. */
const STEAM_TOOL_IDS = new Set(["228980"]);

const STEAM_STATE_UPDATE_REQUIRED = 2;

/**
 * True when Steam has a downloadable update and is not already transferring it.
 * A preload sets the same flag, but `preloaded` means the release build is not
 * out yet, so there is nothing to update.
 */
export function steamUpdatePending(stateFlags: number, downloading = false, preloaded = false): boolean {
  if (downloading || preloaded) return false;
  return (stateFlags & STEAM_STATE_UPDATE_REQUIRED) !== 0;
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
    developer: steamDeveloper(g.appId),
    version: "—",
    installedVersion: null,
    installed: true,
    installPath: g.installDir ? `${g.library}\\common\\${g.installDir}` : g.library,
    installSize: g.sizeBytes,
    coverUrl: `${STEAM_CDN}/${g.appId}/library_600x900.jpg`,
    heroUrl: `${STEAM_CDN}/${g.appId}/library_hero.jpg`,
    description: "",
    updateAvailable: steamUpdatePending(g.stateFlags, g.downloading, g.preloaded),
    downloading: g.downloading,
    bytesDownloaded: g.bytesDownloaded,
    bytesToDownload: g.bytesToDownload,
    genres: steamGenres(g.appId),
    releaseYear: steamReleaseYear(g.appId),
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
    developer: steamDeveloper(g.appId),
    version: "—",
    installedVersion: null,
    installed: false,
    installPath: null,
    installSize: 0,
    coverUrl: `${STEAM_CDN}/${g.appId}/library_600x900.jpg`,
    heroUrl: `${STEAM_CDN}/${g.appId}/library_hero.jpg`,
    description: "",
    updateAvailable: false,
    genres: steamGenres(g.appId),
    releaseYear: steamReleaseYear(g.appId),
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
    const [games, playtimes, status, metadata] = await Promise.all([
      steamListInstalled(),
      steamSyncPlaytime(),
      // The client status also feeds the Accounts page.
      steamStatus().catch(() => null),
      // The client's own app cache carries the studio name and genres offline.
      steamAppMetadata().catch((): Record<string, SteamAppMetadata> => ({})),
    ]);
    installed = games.filter((g) => !isSteamLibraryNoise(g.appId, g.name));
    S.steamGames = installed;
    S.steamStatus = status;
    setSteamMetadata(metadata);
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
  checkAndPollSteamDownloads();
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

/** Latest bytes/s for a live Steam transfer. The manifest itself does not move every second. */
const steamLiveSpeed = new Map<string, number>();
/** App whose Steam chart is being sampled; a change resets the history. */
let steamChartAppId = "";
/** Byte total at the moment a transfer started, so a stale number is not shown as live. */
const steamAwaitFloor = new Map<string, number>();
const steamAwaitSince = new Map<string, number>();
/** Keeps the row on screen while Steam is between "stopped" and the next sample. */
const steamKeepUntil = new Map<string, number>();
const STEAM_AWAIT_MS = 8000;
const STEAM_KEEP_MS = 12000;

function beginSteamAwait(appId: string, bytes: number): void {
  // Only the first call opens the window. The keep branch runs on every
  // snapshot while Steam is between samples, and extending the deadline there
  // kept the row (and its spinner) alive forever after a transfer finished.
  if (steamAwaitSince.has(appId)) return;
  steamAwaitSince.set(appId, Date.now());
  steamAwaitFloor.set(appId, bytes);
  steamKeepUntil.set(appId, Date.now() + STEAM_KEEP_MS);
}

function clearSteamAwait(appId: string): void {
  steamAwaitSince.delete(appId);
  steamAwaitFloor.delete(appId);
}

/** True while the row should show a spinner instead of a stale or empty counter. */
export function steamDownloadWaiting(appId: string): boolean {
  const since = steamAwaitSince.get(appId);
  if (since == null) return false;
  if (Date.now() - since > STEAM_AWAIT_MS) {
    clearSteamAwait(appId);
    return false;
  }
  return true;
}

/** Steam's "Ağ" figure is decimal MB/s (1.8 MB/s), not a 1024-based KB/s value. */
function steamNetSpeed(bytesPerSec: number): string {
  const mb = bytesPerSec / 1_000_000;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
}

/** Percent, byte pair, and speed for one Steam transfer. `pct` is null when Steam has no total yet. */
export function steamDownloadLabel(g: Pick<SteamGame, "bytesDownloaded" | "bytesToDownload">, perSec = 0): { pct: number | null; text: string } {
  const total = g.bytesToDownload > 0 ? g.bytesToDownload : 0;
  const got = Math.max(0, g.bytesDownloaded > 0 ? g.bytesDownloaded : 0);
  const pct = total > 0 ? Math.min(100, Math.round((Math.min(got, total) / total) * 100)) : null;
  const bytes = total > 0 ? `${fmtBytes(Math.min(got, total))} / ${fmtBytes(total)}` : "";
  const speed = perSec > 0 ? steamNetSpeed(perSec) : "";
  const text = [pct !== null ? `%${pct}` : "", bytes, speed].filter(Boolean).join(" · ") || t("steam.downloadingHint");
  return { pct, text };
}

/** Writes the live percent into download rows. A full re-render can leave the old 0% behind. */
function paintSteamDownloadRows(games: SteamGame[]): void {
  let paintedSpeed = false;
  for (const g of games) {
    if (!g.downloading) continue;
    const waiting = steamDownloadWaiting(g.appId);
    const { pct, text } = steamDownloadLabel(g, steamLiveSpeed.get(g.appId) ?? 0);
    const shown = waiting ? t("common.calculating") : text;
    const id = `steam::${g.appId}`;
    const label = pct !== null ? t("common.downloading", { p: pct }) : t("steam.downloading");
    document.querySelectorAll(`[data-dlbtn="${id}"]`).forEach((el) => {
      const span = el.querySelector("span");
      if (span) {
        span.textContent = label;
      } else {
        const svg = el.querySelector("svg");
        if (svg) el.innerHTML = `${svg.outerHTML} ${label}`;
        else el.textContent = label;
      }
    });
    document.querySelectorAll<HTMLElement>(`[data-tv-dlbar="${id}"]`).forEach((bar) => {
      if (pct !== null) bar.style.width = `${pct}%`;
    });
    document.querySelectorAll(`[data-steam-dl="${g.appId}"]`).forEach((meta) => {
      meta.classList.toggle("is-wait", waiting);
      meta.textContent = shown;
    });
    document.querySelectorAll<HTMLElement>(`[data-steam-dlbar="${g.appId}"]`).forEach((bar) => {
      if (pct !== null) bar.style.width = `${pct}%`;
    });
    if (!paintedSpeed) {
      const chip = document.querySelector(".tv-status-chip.is-dl .tv-dl-speed");
      if (chip && !(S.activeDlMetrics && !S.activeDlMetrics.done && S.activeDlMetrics.speedBytes > 0)) {
        chip.textContent = pct !== null ? `%${pct}` : t("steam.downloading");
        paintedSpeed = true;
      }
    }
  }
}

/** Applies a fresh installed/downloading snapshot without hitting the owned-games API. */
export function applySteamInstalledSnapshot(games: SteamGame[]): boolean {
  const previous = S.steamGames.filter((g) => g.downloading).map((g) => ({ ...g }));
  // The manifest is only rewritten at phase changes, so a watcher flush in the
  // middle of a transfer often carries a lower or zero counter. The pulse's
  // log projection is ahead of it; never blink a moving row back to zero.
  const previousById = new Map(previous.map((g) => [g.appId, g]));
  S.steamGames = games
    .filter((g) => !isSteamLibraryNoise(g.appId, g.name))
    .map((g) => {
      const prev = previousById.get(g.appId);
      if (!prev) return g;
      const bytesDownloaded = Math.max(g.bytesDownloaded, prev.bytesDownloaded);
      const bytesToDownload = Math.max(g.bytesToDownload, prev.bytesToDownload);
      return bytesDownloaded === g.bytesDownloaded && bytesToDownload === g.bytesToDownload
        ? g
        : { ...g, bytesDownloaded, bytesToDownload };
    });
  const now = Date.now();
  const liveIds = new Set(S.steamGames.filter((g) => g.downloading).map((g) => g.appId));
  for (const prev of previous) {
    if (liveIds.has(prev.appId)) {
      steamKeepUntil.set(prev.appId, now + STEAM_KEEP_MS);
      continue;
    }
    const fresh = games.find((g) => g.appId === prev.appId);
    // Every byte already on disk means the transfer finished: finalize at once
    // instead of holding the row with a spinner. A pause or a cancel never
    // reaches the total, so those still ride the keep window.
    const finished = fresh != null && fresh.bytesToDownload > 0 && fresh.bytesDownloaded >= fresh.bytesToDownload;
    const until = steamKeepUntil.get(prev.appId) ?? 0;
    if (finished || until <= now) {
      clearSteamAwait(prev.appId);
      steamKeepUntil.delete(prev.appId);
      // Only a finished transfer joins the Downloads tab's completed list.
      if (finished) pushRecentInstall(`steam::${prev.appId}`);
      continue;
    }
    // Steam drops the row for a moment when an update starts. Keep it, and
    // show the spinner until a newer byte sample arrives.
    const existing = S.steamGames.find((g) => g.appId === prev.appId);
    if (existing) existing.downloading = true;
    else S.steamGames.push({ ...prev, downloading: true });
    beginSteamAwait(prev.appId, prev.bytesDownloaded);
  }
  for (const g of S.steamGames) {
    if (!g.downloading) continue;
    const was = previous.find((p) => p.appId === g.appId && p.downloading);
    if (!was) beginSteamAwait(g.appId, 0);
  }
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
    const downloading = g.downloading;
    const updateAvailable = steamUpdatePending(g.stateFlags, downloading, g.preloaded);
    const installed = g.installDir.length > 0 || (g.stateFlags & 4) !== 0;
    const titleChanged = !/^\d+$/.test(g.name) && item.title !== g.name;
    // Size and byte counters move on every Steam write during an update.
    // They must not rebuild the 800+ game library or wipe the grid.
    const sizeChanged = g.sizeBytes > 0 && item.installSize !== g.sizeBytes;
    // A transferring row's counter comes from the pulse, not this flush: the
    // manifest lags behind the log and dips whenever a phase ends.
    const bytesDownloaded = downloading ? Math.max(item.bytesDownloaded ?? 0, g.bytesDownloaded) : g.bytesDownloaded;
    const bytesToDownload = downloading ? Math.max(item.bytesToDownload ?? 0, g.bytesToDownload) : g.bytesToDownload;
    const stateChanged = item.installed !== installed
      || item.downloading !== downloading
      || item.updateAvailable !== updateAvailable
      || titleChanged;
    const progressChanged = sizeChanged
      || item.bytesDownloaded !== bytesDownloaded
      || item.bytesToDownload !== bytesToDownload;
    if (stateChanged || progressChanged) {
      if (!item.updateAvailable && updateAvailable) {
        notify({ kind: "update", title: t("notif.updateAvailable", { title: item.title }), appName: item.key });
      }
      changed = true;
      if (stateChanged) structural = true;
      item.installed = installed;
      item.downloading = downloading;
      item.bytesDownloaded = bytesDownloaded;
      item.bytesToDownload = bytesToDownload;
      item.updateAvailable = updateAvailable;
      if (g.sizeBytes > 0) item.installSize = g.sizeBytes;
      if (!/^\d+$/.test(g.name)) item.title = g.name;
      next.push(item);
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

  // The downloads row can still say 0% after a later render used a stale
  // snapshot. Paint from the merged list so a manifest flush cannot blink a
  // moving row back to zero.
  paintSteamDownloadRows(S.steamGames);
  if (!changed) {
    checkAndPollSteamDownloads();
    return false;
  }
  // Progress-only writes keep the existing objects (already mutated above).
  // Replacing the list rebuilds every store map and throws away the library
  // sort cache, which hitch the UI on every manifest write.
  if (structural) setSteamSummaries(next);
  updateBadge();
  if (structural) {
    scheduleRender();
    if (S.currentModalAppName?.startsWith("steam::")) {
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else {
    for (const g of S.steamGames) {
      if (!g.downloading) continue;
      patchLibraryCardDom(`steam::${g.appId}`);
    }
  }
  checkAndPollSteamDownloads();
  return true;
}

/**
 * Lightweight active-download poller.
 * Runs ONLY while at least one Steam game is actively downloading, stopping
 * immediately when downloads finish so the idle launcher uses 0 CPU.
 */
let steamActiveDlPollTimer: ReturnType<typeof setTimeout> | null = null;

export function checkAndPollSteamDownloads(): void {
  const hasDownloading = S.steamGames.some((g) => g.downloading);
  if (!hasDownloading) {
    if (steamActiveDlPollTimer !== null) {
      clearTimeout(steamActiveDlPollTimer);
      steamActiveDlPollTimer = null;
    }
    return;
  }
  if (steamActiveDlPollTimer !== null) return;

  const poll = async () => {
    steamActiveDlPollTimer = null;
    if (!S.steamGames.some((g) => g.downloading)) return;

    await pulseSteamDownloads();
    // A full library scan on this timer used to pile up. The pulse only arms
    // the next tick when it did not already do that itself.
    if (steamActiveDlPollTimer === null) checkAndPollSteamDownloads();
  };

  steamActiveDlPollTimer = setTimeout(poll, 1000);
}

/** Moves the on-screen counter every second. The manifest is not rewritten that often. */
async function pulseSteamDownloads(): Promise<void> {
  let rows: Awaited<ReturnType<typeof steamDownloadLive>>;
  try {
    rows = await steamDownloadLive();
  } catch {
    return;
  }
  if (rows.length === 0) {
    steamLiveSpeed.clear();
    S.steamSpeedBytes = 0;
    steamChartAppId = "";
    await refreshSteamInstalled();
    return;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.appId);
    if (row.bytesPerSec > 0) steamLiveSpeed.set(row.appId, row.bytesPerSec);
    else steamLiveSpeed.delete(row.appId);
    const floor = steamAwaitFloor.get(row.appId) ?? 0;
    if (row.bytesPerSec > 0 || row.bytesDownloaded > floor) clearSteamAwait(row.appId);
    const game = S.steamGames.find((g) => g.appId === row.appId);
    if (!game) continue;
    game.downloading = true;
    game.bytesDownloaded = row.bytesDownloaded;
    game.bytesToDownload = row.bytesToDownload;
    const item = S.steamSummaries.find((entry) => entry.id === row.appId);
    if (item) {
      item.downloading = true;
      item.bytesDownloaded = row.bytesDownloaded;
      item.bytesToDownload = row.bytesToDownload;
    }
  }
  for (const id of [...steamLiveSpeed.keys()]) {
    if (!seen.has(id)) steamLiveSpeed.delete(id);
  }
  // The Downloads page's Steam card samples S.steamSpeedBytes once a second
  // through the shared chart timer; a new job starts its chart from zero.
  const lead = S.steamGames.find((g) => g.downloading);
  S.steamSpeedBytes = lead ? (steamLiveSpeed.get(lead.appId) ?? 0) : 0;
  if (lead && lead.appId !== steamChartAppId) {
    steamChartAppId = lead.appId;
    S.steamPeakSpeedBytes = 0;
    S.steamSpeedHistory.fill(0);
  }
  paintSteamDownloadRows(S.steamGames);
}

/** One scan at a time. The file watcher and the download poller both call this. */
let steamScanInFlight: Promise<void> | null = null;

/** Re-reads local Steam manifests after the client writes an update or download. */
export function refreshSteamInstalled(): Promise<void> {
  if (steamScanInFlight) return steamScanInFlight;
  steamScanInFlight = (async () => {
    try {
      applySteamInstalledSnapshot(await steamListInstalled());
    } catch {
      // Keep the last snapshot.
    } finally {
      steamScanInFlight = null;
    }
  })();
  return steamScanInFlight;
}

export function startSteamLibraryWatch(): void {
  if (!isTauri) return;
  void invoke("steam_watch_library").catch(() => {});
  // Steam's own Running flag also covers games the launcher did not start:
  // a game already open at boot lands in the running and recent lists.
  void steamWatchRunning()
    .then((ids) => {
      let changed = false;
      for (const id of ids) {
        const key = `steam::${id}`;
        if (S.runningGames.has(key)) continue;
        S.runningGames.add(key);
        pushRecent(key);
        changed = true;
      }
      if (changed) scheduleRender();
    })
    .catch(() => {});
}
