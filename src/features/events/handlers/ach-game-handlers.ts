/**
 * Per-game achievement notification bell on the game page.
 *
 * The button only flips the stored flag and repaints itself; the running
 * watcher is told immediately so a mid-session change takes effect.
 */

import { achGameNotificationsEnabled, setAchGameNotifications } from "../../../core/ach-game-prefs";
import { icon } from "../../../core/icons";
import { toast } from "../../../core/toast";
import { t } from "../../../i18n";
import { steamSetAchievementNotifications } from "../../../steam";

export function handleAchievementGameAction(
  act: string | undefined,
  button: HTMLElement,
): boolean {
  if (act !== "toggle-ach-game-notif") return false;

  const key = button.dataset.id?.trim();
  if (!key) return true;

  const enabled = !achGameNotificationsEnabled(key);
  setAchGameNotifications(key, enabled);

  const steamId = button.dataset.steamAppid?.trim();
  if (steamId) {
    void steamSetAchievementNotifications(steamId, enabled).catch(() => {});
  }

  button.classList.toggle("is-off", !enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.innerHTML = icon(enabled ? "bell" : "bell-off", 16);
  toast(t(enabled ? "ach.gameNotifOn" : "ach.gameNotifOff"), "ok");
  return true;
}
