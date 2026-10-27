/**
 * Keeps the native achievement watcher alive for every Steam client game.
 *
 * The watcher used to start only when the launcher handed a game to Steam, so a
 * title started from the Steam client (or a session that outlived a launcher
 * restart) never produced unlock cards. Both the `game-status` event and the
 * running-state poll funnel through here; the Set makes repeated reports
 * idempotent, because restarting a watcher resets its unlock baseline.
 */

import { steamStartAchievementWatcher, steamStopAchievementWatcher } from "../steam";

const watched = new Set<string>();

function appIdOf(appName: string): string | null {
  if (!appName.startsWith("steam::")) return null;
  const appId = appName.slice("steam::".length);
  return /^\d+$/.test(appId) ? appId : null;
}

/** Starts the watcher for a running Steam game once per session. */
export function watchSteamAchievements(appName: string): void {
  const appId = appIdOf(appName);
  if (!appId || watched.has(appId)) return;
  watched.add(appId);
  void steamStartAchievementWatcher(appId).catch(() => watched.delete(appId));
}

/** Stops the watcher; the backend emits the final snapshot on its way out. */
export function unwatchSteamAchievements(appName: string): void {
  const appId = appIdOf(appName);
  if (!appId || !watched.delete(appId)) return;
  // The client flushes its stats file a moment after the process exits. A
  // watcher that stops at once misses the last unlock, so give it time for one
  // more read; a session restarted in the meantime keeps its new watcher.
  window.setTimeout(() => {
    if (watched.has(appId)) return;
    void steamStopAchievementWatcher(appId).catch(() => {});
  }, 4000);
}
