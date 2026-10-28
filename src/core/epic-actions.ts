/**
 * Shared Epic game actions: launch, install, cancel, uninstall and refresh.
 *
 * These orchestrate backend commands and shared state. They are used by the
 * event router and by feature modules (library, downloads, DLC, manage).
 */

import {
  checkInstallPathState,
  epicCancelDownload,
  epicCheckUpdates,
  epicGetQueue,
  epicInstallGame,
  epicLaunchGame,
  epicLaunchSupport,
  epicStopGame,
  epicListInstalled,
  epicListSkipped,
  epicUninstallGame,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
  summarize,
  stopGameAtPath,
} from "../epic";
import { isTauri, IGNORED_UPDATES_KEY } from "./constants";
import { closeModal } from "./dom";
import { closeManagePopup } from "../features/manage/manage-view";
import { t } from "../i18n";
import { gogLaunchGame, gogStopGame, gogUninstallGame } from "../gog";
import { steamGameAction } from "../steam";
import { watchSteamAchievements } from "./steam-watch";
import { companionLaunch } from "../companion";
import { nileLaunch, nileStop } from "../nile";
import { epicDlProgress, patchLibraryCardDom, refreshGameActionUi } from "./game-view";
import { updateBadge } from "./nav";
import { pruneRecent, pushRecent } from "./recent";
import { notify, render } from "./render";
import { isCompanionKey, rawOf, setEpicSummaries, summaryOf } from "./selectors";
import { S } from "./state";
import { progressToast, toast, type ProgressToast } from "./toast";
import {
  clearEpicLauncherNotice,
  showEpicLauncherNotice,
  showEpicRelayNoticeOnce,
} from "../features/epic-launcher/epic-launcher-notice";
import { syncLibraryHeadingCount } from "../features/library/library-view";
import { blockedOffline } from "./offline";

/** A launch can spend a while creating a compatibility prefix; its toast stays
 *  open and receives progress text until the launch call returns. */
const launchToasts = new Map<string, ProgressToast>();

function beginLaunch(appName: string): void {
  clearLaunchStatus(appName);
  launchToasts.set(appName, progressToast(t("dl.launching")));
}

export function updateLaunchStatus(appName: string, message: string): void {
  launchToasts.get(appName)?.update(message);
}

export function clearLaunchStatus(appName: string): void {
  launchToasts.get(appName)?.close();
  launchToasts.delete(appName);
}

async function launchWithStatus(
  appName: string,
  run: () => Promise<string>,
): Promise<void> {
  beginLaunch(appName);
  try {
    await run();
    clearLaunchStatus(appName);
  } catch (error) {
    clearLaunchStatus(appName);
    toast(String(error), "err");
  }
}

/** Launch a game and record it in the recent list. */
export async function epicStop(appName: string): Promise<void> {
  try {
    if (appName.startsWith("custom::")) {
      const { customGamesStop } = await import("../custom-games");
      // The Rust launch thread reports the exit and the session totals; do not
      // clear the running state here or that event would be treated as a
      // duplicate and the hours would be dropped.
      await customGamesStop(appName);
      return;
    }
    if (appName.startsWith("steam::") || isCompanionKey(appName)) {
      // Client-owned stores have no stop command of their own: kill the
      // processes under this install folder; the backend emits game-status
      // false so the playtime session still closes.
      const summary = summaryOf(appName);
      if (!summary?.installPath) {
        toast(t("dl.notInstalled"), "err");
        return;
      }
      const msg = await stopGameAtPath(appName, summary.installPath);
      toast(msg, "ok");
      return;
    }
    if (appName.startsWith("amazon::")) {
      const msg = await nileStop(appName.slice(8));
      S.runningGames.delete(appName);
      toast(msg, "ok");
      refreshGameActionUi(appName);
      return;
    }
    const msg = appName.startsWith("gog::")
      ? await gogStopGame(appName)
      : await epicStopGame(appName);
    S.runningGames.delete(appName);
    toast(msg, "ok");
    refreshGameActionUi(appName);
  } catch (e) {
    toast(String(e), "err");
  }
}

export async function epicPlay(appName: string): Promise<void> {
  if (appName.startsWith("custom::")) {
    pushRecent(appName);
    toast(t("dl.launching"), "");
    try {
      const { customGamesLaunch } = await import("../custom-games");
      await customGamesLaunch(appName);
    } catch (e) {
      toast(String(e), "err");
    }
    return;
  }
  // A copy whose drive or folder disappeared cannot launch. Name the problem
  // instead of letting the store CLI return a raw filesystem error.
  if (isTauri && !appName.startsWith("steam::") && !isCompanionKey(appName)) {
    const summary = summaryOf(appName);
    if (summary?.installed && summary.installPath) {
      const state = await checkInstallPathState(summary.installPath).catch(() => null);
      if (state?.state === "driveMissing" || state?.state === "missing") {
        toast(t("sys.copyHealthTip"), "err");
        return;
      }
    }
  }
  // Amazon Games is installed and launched by the launcher through Nile.
  if (appName.startsWith("amazon::")) {
    pushRecent(appName);
    await launchWithStatus(appName, () => nileLaunch(appName.slice(8)));
    return;
  }
  // Steam games belong to the Steam client: hand the launch over to it.
  if (isCompanionKey(appName)) {
    pushRecent(appName);
    toast(t("dl.launching"), "");
    const store = appName.slice(0, appName.indexOf("::")) as "ea" | "ubisoft" | "xbox" | "battlenet" | "riot";
    const gameId = appName.slice(appName.indexOf("::") + 2);
    try {
      await companionLaunch(store, gameId);
    } catch (e) {
      toast(String(e), "err");
    }
    return;
  }
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    watchSteamAchievements(appName);
    pushRecent(appName);
    toast(t("dl.launching"), "");
    try {
      await steamGameAction(appId, "launch");
    } catch (e) {
      toast(String(e), "err");
    }
    return;
  }
  pushRecent(appName);
  if (appName.startsWith("gog::")) {
    await launchWithStatus(appName, () => gogLaunchGame(appName));
    return;
  }
  const title = S.epicSummariesMap.get(appName)?.title || appName;
  // Rockstar's Epic stubs only start when a process named Epic Games Launcher
  // is in their parent chain: the launcher relays that itself. Say so once, and
  // keep Epic's client as the fallback when the relay cannot be used.
  const support = await epicLaunchSupport(appName).catch(() => null);
  if (support?.needsEpicLauncher) {
    if (support.epicLauncherInstalled) clearEpicLauncherNotice();
    else showEpicRelayNoticeOnce(appName, title);
  }
  beginLaunch(appName);
  try {
    await epicLaunchGame(appName);
    clearLaunchStatus(appName);
  } catch (e) {
    clearLaunchStatus(appName);
    const raw = String(e);
    if (raw.startsWith("@t:dl.needsEpicLauncher")) {
      showEpicLauncherNotice(appName, title);
      return;
    }
    toast(raw, "err");
  }
}

/** Start (or update) a game installation, wiring up the download metrics. */
export async function epicInstall(appName: string, installDir?: string | null): Promise<void> {
  const s = S.epicSummariesMap.get(appName);
  if (!s || epicDlProgress(appName) !== null) return;
  // Downloads need the network; offline mode says no before any UI spins up.
  if (blockedOffline(t("net.whatDownload"))) return;
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  if (requiresThirdPartyLauncher(partner)) {
    void epicPlay(appName);
    return;
  }
  S.downloads.set(appName, { progress: 0, done: false, title: s.title });
  if (!S.activeDlMetrics || S.activeDlMetrics.done) {
    S.activeDlMetrics = {
      id: appName,
      title: s.title,
      progress: 0,
      done: false,
      speed: t("dl.starting"),
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: t("common.calculating"),
      downloadedBytes: 0,
      totalBytes: s.installSize || 0,
    };
  }
  updateBadge();
  refreshGameActionUi(appName);
  void epicGetQueue().then((q) => {
    S.dlQueueStatus = q;
    if (S.view === "downloads") render();
    else if (S.view === "library") refreshGameActionUi(appName);
  }).catch(() => {
    if (S.view === "downloads") render();
    else if (S.view === "library") refreshGameActionUi(appName);
  });
  try {
    const msg = await epicInstallGame(appName, installDir ?? undefined);
    if (S.ignoredUpdates.has(appName)) {
      S.ignoredUpdates.delete(appName);
      localStorage.setItem(IGNORED_UPDATES_KEY, JSON.stringify([...S.ignoredUpdates]));
      updateBadge();
    }
    toast(msg, "ok");
    S.dlQueueStatus = (await epicGetQueue()) ?? S.dlQueueStatus;
    if (S.view === "downloads") render();
    else if (S.view === "library") refreshGameActionUi(appName);
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    toast(String(e), "err");
    if (S.view === "downloads") render();
    else if (S.view === "library") refreshGameActionUi(appName);
  }
}

/** Cancel an active download. */
export async function epicCancel(appName: string): Promise<void> {
  try {
    const msg = await epicCancelDownload(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
}

/** Uninstall a game, close the drawer and refresh installed state. */
export async function epicUninstall(appName: string): Promise<void> {
  // Close before the command returns so the dialog cannot be clicked again.
  closeManagePopup();
  closeModal();
  try {
    if (appName.startsWith("gog::")) {
      const cleanId = appName.slice(5);
      const msg = await gogUninstallGame(cleanId);
      toast(msg, "ok");
      // Update in-memory state
      const g = S.gogSummariesMap.get(cleanId);
      if (g) {
        g.installed = false;
        g.installPath = null;
        g.installSize = 0;
        g.installedVersion = null;
      }
      const item = S.allGamesMap.get(appName);
      if (item) {
        item.installed = false;
        item.installPath = null;
        item.installSize = 0;
        item.installedVersion = null;
      }
    } else {
      const msg = await epicUninstallGame(appName);
      toast(msg, "ok");
      // Update in-memory state immediately so UI and any concurrent checks reflect uninstalled state
      const s = S.epicSummariesMap.get(appName);
      if (s) {
        s.installed = false;
        s.installPath = null;
        s.installSize = 0;
        s.installedVersion = null;
        s.updateAvailable = false;
      }
      const item = S.allGamesMap.get(appName);
      if (item) {
        item.installed = false;
        item.installPath = null;
        item.installSize = 0;
        item.installedVersion = null;
      }
      S.availableUpdates.delete(appName);
      await refreshEpicInstalled();
    }
  } catch (e) {
    toast(String(e), "err");
  }
  S.availableUpdates.delete(appName);
  if (S.ignoredUpdates.has(appName)) {
    S.ignoredUpdates.delete(appName);
    localStorage.setItem(IGNORED_UPDATES_KEY, JSON.stringify([...S.ignoredUpdates]));
  }
  closeManagePopup();
  if (S.view === "library") patchLibraryCardDom(appName);
  if (S.view === "downloads") render();
}

/** Re-read the installed list from Legendary and refresh the UI. */
export async function refreshEpicInstalled(): Promise<void> {
  if (!isTauri) return;
  try {
    const [einstalled, eskipped] = await Promise.all([epicListInstalled(), epicListSkipped()]);
    setEpicSummaries(summarize(S.epicGamesRaw, einstalled, eskipped));
    pruneRecent();
    S.epicSkippedCount = eskipped.length;
    // Installed membership changed: refresh the badge and the sidebar list
    // even when the library grid itself is not on screen.
    updateBadge();
    if (S.view === "library") syncLibraryHeadingCount();
    void refreshUpdates();
  } catch (e) {
    toast(t("lib.installedRefreshFailed", { msg: String(e) }), "err");
  }
}

/** Whether the first update sweep already ran (skip notifications for it). */
let updatesCheckedOnce = false;

/** Check for pending updates across all installed games. */
export async function refreshUpdates(): Promise<void> {
  if (!isTauri || S.offlineMode) return;
  try {
    const updates = await epicCheckUpdates();
    const firstRun = !updatesCheckedOnce;
    updatesCheckedOnce = true;
    const prev = new Set(S.availableUpdates.keys());
    S.availableUpdates.clear();
    for (const u of updates) {
      const summary = S.epicSummariesMap.get(u.appName);
      if (!summary || !summary.installed) continue;
      S.availableUpdates.set(u.appName, u);
      if (!firstRun && !prev.has(u.appName)) {
        const title = S.epicSummariesMap.get(u.appName)?.title ?? u.appName;
        notify({ kind: "update", title: t("notif.updateAvailable", { title }), appName: u.appName });
      }
    }
    S.libraryDataRev++;
    updateBadge();
    if (S.view === "downloads") render();
    if (S.view === "library") {
      document.querySelectorAll<HTMLElement>("[data-lib-item]").forEach((card) => {
        const id = card.dataset.libItem;
        if (!id) return;
        const should = S.availableUpdates.has(id) || Boolean(S.epicSummariesMap.get(id)?.updateAvailable);
        const hasBadge = Boolean(card.querySelector(".pbadge.update"));
        if (should !== hasBadge) patchLibraryCardDom(id);
      });
    }
  } catch (e) {
    console.warn("Update check could not be performed:", e);
  }
}
