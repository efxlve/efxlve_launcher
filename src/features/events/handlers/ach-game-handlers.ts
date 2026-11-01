/**
 * Per-game achievement notification switch (game page > Achievements).
 *
 * The switch only flips the stored flag; a running watcher is told immediately
 * so a mid-session change takes effect.
 */

import { invoke } from "@tauri-apps/api/core";
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
  const title = control.dataset.title?.trim() || "";

  const checkbox =
    control instanceof HTMLInputElement && control.type === "checkbox"
      ? control
      : control.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const enabled = !achGameNotificationsEnabled(key, title);
  setAchGameNotifications(key, enabled, title);
  if (checkbox) checkbox.checked = enabled;

  const steamId = control.dataset.steamAppid?.trim();
  // The store bridge keeps the launcher key in the payload, so the watcher
  // needs that key as well as the bare Steam AppID.
  void steamSetAchievementNotifications(key, enabled).catch(() => {});
  if (steamId) {
    void steamSetAchievementNotifications(steamId, enabled).catch(() => {});
  }
  // The backend keeps its own anti-cheat copy: a stale watcher map must not put
  // a card over a protected game after the reader turned notifications off.
  void invoke("overlay_set_anti_cheat_notifications", {
    appName: key,
    title,
    allowed: enabled,
  }).catch(() => {});

  // The switch itself already reflects the state; only the leading glyph is
  // swapped, so the page does not have to re-render for one toggle. The notice
  // above About the Game uses the same action with a plain input, which has no
  // glyph; it updates its own state line instead.
  const glyph =
    control instanceof HTMLInputElement
      ? control.closest(".ach-notif-row")?.querySelector<HTMLElement>(".ach-notif-icon")
      : control.matches('[data-act="toggle-ach-game-notif"]')
        ? control
        : control.closest(".ach-notif-row")?.querySelector<HTMLElement>(".ach-notif-icon");
  if (glyph) {
    glyph.innerHTML = icon(enabled ? "bell" : "bell-off", 14);
    glyph.classList.toggle("is-off", !enabled);
    glyph.setAttribute("aria-pressed", String(enabled));
  }
  const notice = control.closest<HTMLElement>("#gp-ac-notice");
  if (notice) {
    const state = notice.querySelector<HTMLElement>("[data-ach-state]");
    if (state) {
      state.textContent = t(enabled ? "drawer.acNoticeNotifOn" : "drawer.acNoticeNotifOff");
    }
    control.closest(".gp-ac-notice-toggle")?.classList.toggle("is-on", enabled);
  }

  toast(t(enabled ? "ach.gameNotifOn" : "ach.gameNotifOff"), "ok");
  return true;
}
