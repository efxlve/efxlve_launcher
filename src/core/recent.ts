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
  S.epicRecent = S.epicRecent.filter((id) =>
    S.epicSummaries.some((s) => s.appName === id && s.installed),
  );
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

/** Record a newly installed or updated game id to the front of the recent installs list. */
export function pushRecentInstall(appName: string): void {
  try {
    const list = getRecentInstalls();
    const next = [appName, ...list.filter((x) => x !== appName)].slice(0, 12);
    localStorage.setItem(RECENT_INSTALLS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or parsing errors
  }
}

/** Read recent install and update game ids from storage. */
export function getRecentInstalls(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_INSTALLS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
