/**
 * Per-game achievement notification switches.
 *
 * Muted games are stored by library key (`steam::123`, `custom::…`) in
 * localStorage, next to the overlay's per-game list. The Rust watcher only
 * knows the Steam AppID, so the frontend forwards the matching flag before a
 * watcher starts and whenever the game-page bell changes.
 */

import { ACH_DISABLED_GAMES_KEY } from "./constants";

function read(): string[] {
  try {
    const raw = localStorage.getItem(ACH_DISABLED_GAMES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function write(next: string[]): void {
  try {
    localStorage.setItem(ACH_DISABLED_GAMES_KEY, JSON.stringify(next));
  } catch {
    // A full quota should not break the game page.
  }
}

/** True unless the user muted achievements for this game. */
export function achGameNotificationsEnabled(appName: string): boolean {
  return Boolean(appName) && !read().includes(appName);
}

/** Mutes or unmutes one game; unknown games are enabled by default. */
export function setAchGameNotifications(appName: string, enabled: boolean): void {
  if (!appName) return;
  const current = read();
  const next = enabled
    ? current.filter((key) => key !== appName)
    : Array.from(new Set([...current, appName]));
  write(next);
}

/** Keys the user muted, for a settings list or a future bulk reset. */
export function achDisabledGames(): string[] {
  return read();
}
