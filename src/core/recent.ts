/**
 * Recently played games list (max 8, persisted in localStorage).
 *
 * `pushRecent` must only be called when a game actually launches, never when a
 * detail modal is opened.
 */

import { RECENT_INSTALLS_KEY, RECENT_KEY } from "./constants";
import { updateChrome } from "./nav";
import { summaryOf } from "./selectors";
import { S } from "./state";

/** Drop entries that are no longer installed. */
export function pruneRecent(): void {
  S.epicRecent = S.epicRecent.filter((id) => Boolean(summaryOf(id)?.installed));
  localStorage.setItem(RECENT_KEY, JSON.stringify(S.epicRecent));
}

/** Move a game to the front of the recent list (only if installed). */
export function pushRecent(appName: string): void {
  const s = summaryOf(appName);
  if (!s || !s.installed) return;
  S.epicRecent = [appName, ...S.epicRecent.filter((x) => x !== appName)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(S.epicRecent));
  updateChrome();
}

/** A finished download, newest first (max 12, persisted in localStorage). */
export interface RecentDownload {
  id: string;
  at: number;
  /** Bytes this transfer moved; 0 when unknown (records from older builds). */
  bytes: number;
}

/**
 * Record a newly installed or updated game id to the front of the recent
 * downloads list. `bytes` is the size of the transfer itself, not of the
 * installed folder: an update downloads a fraction of the game.
 */
export function pushRecentInstall(appName: string, bytes = 0): void {
  try {
    const list = getRecentDownloads();
    const moved = Math.max(0, Math.round(bytes));
    const next = [
      { id: appName, at: Date.now(), bytes: moved },
      ...list.filter((x) => x.id !== appName),
    ].slice(0, 12);
    localStorage.setItem(RECENT_INSTALLS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or parsing errors
  }
}

/** Drops one finished download from the list. The game itself stays installed. */
export function removeRecentDownload(id: string): void {
  try {
    const next = getRecentDownloads().filter((entry) => entry.id !== id);
    localStorage.setItem(RECENT_INSTALLS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or parsing errors
  }
}

/** Clears the finished-downloads list, like Steam's "Clear all". */
export function clearRecentDownloads(): void {
  try {
    localStorage.setItem(RECENT_INSTALLS_KEY, JSON.stringify([]));
  } catch {
    // Ignore storage quota or parsing errors
  }
}

/**
 * Read the recently finished downloads, newest first. The older id-only format
 * is still accepted, so an upgrade does not lose the list.
 */
export function getRecentDownloads(): RecentDownload[] {
  try {
    const raw = localStorage.getItem(RECENT_INSTALLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): RecentDownload[] => {
      if (typeof entry === "string") return entry ? [{ id: entry, at: 0, bytes: 0 }] : [];
      if (entry && typeof entry === "object") {
        const id = (entry as { id?: unknown }).id;
        const at = (entry as { at?: unknown }).at;
        const bytes = (entry as { bytes?: unknown }).bytes;
        if (typeof id === "string" && id) {
          return [{
            id,
            at: typeof at === "number" ? at : 0,
            bytes: typeof bytes === "number" && bytes > 0 ? bytes : 0,
          }];
        }
      }
      return [];
    });
  } catch {
    return [];
  }
}
