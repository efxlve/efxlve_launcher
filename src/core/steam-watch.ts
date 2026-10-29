/**
 * Keeps the native achievement watcher alive for every Steam client game.
 *
 * The watcher used to start only when the launcher handed a game to Steam, so a
 * title started from the Steam client (or a session that outlived a launcher
 * restart) never produced unlock cards. Both the `game-status` event and the
 * running-state poll funnel through here; the Set makes repeated reports
 * idempotent, because restarting a watcher resets its unlock baseline.
 */

import { currentLanguage } from "../i18n";
import { steamSetAchievementNotifications, steamStartAchievementWatcher, steamStopAchievementWatcher } from "../steam";
import { achGameNotificationsEnabled } from "./ach-game-prefs";

const watched = new Set<string>();

function appIdOf(appName: string): string | null {
  if (!appName.startsWith("steam::")) return null;
  const appId = appName.slice("steam::".length);
  return /^\d+$/.test(appId) ? appId : null;
}

/** Starts the watcher for a running Steam game once per session. */
export function watchSteamAchievements(appName: string): void {
  const appId = appIdOf(appName);
  if (!appId) return;
  // The Rust watcher only knows the AppID; carry the per-game mute over before
  // it can see an unlock (a watcher that outlived a page change too).
  void steamSetAchievementNotifications(appId, achGameNotificationsEnabled(appName)).catch(
    () => {},
  );
  if (watched.has(appId)) return;
  watched.add(appId);
  void steamStartAchievementWatcher(appId, currentLanguage()).catch(() => watched.delete(appId));
}

/** Stops the watcher; the backend emits the final snapshot on its way out. */
export function unwatchSteamAchievements(appName: string): void {
  const appId = appIdOf(appName);
  if (!appId || !watched.delete(appId)) return;
  // The client flushes its stats file a moment after the process exits, and a
  // slow cloud sync can push that to several seconds. The watcher only reads a
  // couple of small local files per poll, so keeping it alive this long costs
  // no measurable CPU or memory; a session restarted in the meantime keeps its
  // new watcher.
  window.setTimeout(() => {
    if (watched.has(appId)) return;
    void steamStopAchievementWatcher(appId).catch(() => {});
  }, 8000);
}
