/**
 * Epic Games Launcher notices for companion-launcher titles.
 *
 * Rockstar ships its Epic titles behind a small `Play*.exe` stub that only
 * continues when a process named `EpicGamesLauncher.exe` is in its ancestor
 * chain. The launcher relays that itself (see `src-tauri/src/epic_shim.rs`), so
 * Epic's client is normally not needed; these notices explain the relay once
 * and keep Epic's download as the fallback for when the relay cannot be used.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { S } from "../../core/state";
import { t } from "../../i18n";
import {
  dismissNotification,
  pushNotification,
  renderNotificationPanel,
} from "../notifications/notifications";

const NOTICE_ACT = "install-epic-launcher";
/** The one-time relay notice has been shown on this PC. */
const RELAY_NOTICE_KEY = "efxlve-epic-relay-notice";
/** Official launcher download page (the client is free). */
const DOWNLOAD_URL = "https://store.epicgames.com/download";

/** Opens the Epic Games Launcher download page in the browser. */
export function openEpicLauncherDownload(): void {
  void openUrl(DOWNLOAD_URL).catch(() => undefined);
}

function pushNotice(appName: string, title: string, body: string): void {
  pushNotification({
    kind: "info",
    title,
    body,
    appName,
    action: NOTICE_ACT,
    actionLabel: t("notif.epicLauncherAction"),
  });
  if (S.notifOpen) renderNotificationPanel();
}

/**
 * First relay start of a Rockstar title: say once that the launcher stands in
 * for the Epic Games Launcher, with Epic's download as the fallback.
 */
export function showEpicRelayNoticeOnce(appName: string, title: string): void {
  if (localStorage.getItem(RELAY_NOTICE_KEY) === "1") return;
  localStorage.setItem(RELAY_NOTICE_KEY, "1");
  pushNotice(
    appName,
    t("notif.epicRelayTitle"),
    t("notif.epicRelayBody", { title }),
  );
}

/** The relay could not be created: the Epic Games Launcher is the only route. */
export function showEpicLauncherNotice(appName: string, title: string): void {
  pushNotice(
    appName,
    t("notif.epicLauncherTitle"),
    t("notif.epicLauncherBody", { title }),
  );
}

/** The Launcher is installed (or the title no longer needs it): drop the notices. */
export function clearEpicLauncherNotice(): void {
  const stale = S.notifications.filter((n) => n.action === NOTICE_ACT);
  if (!stale.length) return;
  for (const note of stale) dismissNotification(note.id);
  if (S.notifOpen) renderNotificationPanel();
}
