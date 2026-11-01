/**
 * Per-game achievement notification switches.
 *
 * Muted games are stored by library key (`steam::123`, `custom::…`) in
 * localStorage, next to the overlay's per-game list. Anti-cheat titles are
 * muted by default: their notification switch is an explicit opt-in, stored in
 * a separate allow list so "not muted" keeps meaning "the reader asked for
 * this game". The Rust watcher only knows the Steam AppID, so the frontend
 * forwards the matching flag before a watcher starts and whenever the game-page
 * bell changes.
 */

import { gameTitleKey, getAntiCheat } from "../epic-model";
import { ACH_ANTI_CHEAT_ALLOW_KEY, ACH_DISABLED_GAMES_KEY } from "./constants";
import { S } from "./state";

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeList(key: string, next: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // A full quota should not break the game page.
  }
}

function mutedGames(): string[] {
  return readList(ACH_DISABLED_GAMES_KEY);
}

function allowedAntiCheatGames(): string[] {
  return readList(ACH_ANTI_CHEAT_ALLOW_KEY);
}

/** The store title is the shared identity; fall back to the library slug when
 *  the map has not been filled yet (a watcher can start early). */
function titleOf(appName: string, titleHint: string): string {
  return (
    titleHint ||
    S.allGamesMap.get(appName)?.title ||
    appName.split("::").pop()?.replace(/[-_]+/g, " ") ||
    ""
  );
}

function antiCheatOf(appName: string, titleHint: string): string | null {
  return getAntiCheat(undefined, titleOf(appName, titleHint), appName);
}

function allowKeys(appName: string, title: string): string[] {
  return [appName, gameTitleKey(title)].filter(Boolean);
}

/** True when the reader explicitly allowed notifications for an anti-cheat
 *  game. A title key keeps the Ubisoft and Epic copies of one game in sync. */
export function achAntiCheatNotificationsAllowed(appName: string, titleHint = ""): boolean {
  if (!appName) return false;
  const keys = allowKeys(appName, titleOf(appName, titleHint));
  const allowed = allowedAntiCheatGames();
  return keys.some((key) => allowed.includes(key));
}

function setAntiCheatAllowed(appName: string, enabled: boolean, title: string): void {
  const keys = allowKeys(appName, title);
  if (keys.length === 0) return;
  const allowed = allowedAntiCheatGames();
  const next = enabled
    ? Array.from(new Set([...allowed, ...keys]))
    : allowed.filter((key) => !keys.includes(key));
  writeList(ACH_ANTI_CHEAT_ALLOW_KEY, next);
}

/** True when achievement cards should play for this game. Anti-cheat titles
 *  stay muted until the reader opts in, even if the manual mute list is empty. */
export function achGameNotificationsEnabled(appName: string, titleHint = ""): boolean {
  if (!appName || mutedGames().includes(appName)) return false;
  if (antiCheatOf(appName, titleHint) && !achAntiCheatNotificationsAllowed(appName, titleHint)) {
    return false;
  }
  return true;
}

/** Mutes or unmutes one game. Turning an anti-cheat game on records the opt-in;
 *  turning it off drops the opt-in and restores the safe default. */
export function setAchGameNotifications(
  appName: string,
  enabled: boolean,
  titleHint = "",
): void {
  if (!appName) return;
  const current = mutedGames();
  const next = enabled
    ? current.filter((key) => key !== appName)
    : Array.from(new Set([...current, appName]));
  writeList(ACH_DISABLED_GAMES_KEY, next);
  if (antiCheatOf(appName, titleHint)) {
    setAntiCheatAllowed(appName, enabled, titleOf(appName, titleHint));
  }
}

/** Keys the user muted, for a settings list or a future bulk reset. */
export function achDisabledGames(): string[] {
  return mutedGames();
}
