/**
 * Per-game achievement notification switch (game page > Achievements).
 *
 * The switch only flips the stored flag; a running watcher is told immediately
 * so a mid-session change takes effect.
 */

import { achGameNotificationsEnabled, setAchGameNotifications } from "../../../core/ach-game-prefs";
import { icon } from "../../../core/icons";
import { toast } from "../../../core/toast";
import { t } from "../../../i18n";
import { steamSetAchievementNotifications } from "../../../steam";

export function handleAchievementGameAction(
  act: string | undefined,
  control: HTMLElement,
): boolean {
  if (act !== "toggle-ach-game-notif") return false;

  const key = control.dataset.id?.trim();
  if (!key) return true;

  const checkbox =
    control instanceof HTMLInputElement && control.type === "checkbox"
      ? control
      : control.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const enabled = !achGameNotificationsEnabled(key);
  setAchGameNotifications(key, enabled);
  if (checkbox) checkbox.checked = enabled;

  const steamId = control.dataset.steamAppid?.trim();
  // The store bridge keeps the launcher key in the payload, so the watcher
  // needs that key as well as the bare Steam AppID.
  void steamSetAchievementNotifications(key, enabled).catch(() => {});
  if (steamId) {
    void steamSetAchievementNotifications(steamId, enabled).catch(() => {});
  }

  // The switch itself already reflects the state; only the leading glyph is
  // swapped, so the page does not have to re-render for one toggle.
  const glyph = control.matches('[data-act="toggle-ach-game-notif"]')
    ? control
    : control.closest(".ach-notif-row")?.querySelector<HTMLElement>(".ach-notif-icon");
  if (glyph) {
    glyph.innerHTML = icon(enabled ? "bell" : "bell-off", 14);
    glyph.classList.toggle("is-off", !enabled);
    glyph.setAttribute("aria-pressed", String(enabled));
  }

  toast(t(enabled ? "ach.gameNotifOn" : "ach.gameNotifOff"), "ok");
  return true;
}
