/**
 * Shared Epic game actions: launch, install, cancel, uninstall and refresh.
 *
 * These orchestrate backend commands and shared state. They are used by the
 * event router and by feature modules (library, downloads, DLC, manage).
 */

import {
  epicCancelDownload,
  epicCheckUpdates,
  epicGetQueue,
  epicInstallGame,
  epicLaunchGame,
  epicStopGame,
  epicListInstalled,
  epicListSkipped,
  epicUninstallGame,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
  summarize,
} from "../epic";
import { isTauri } from "./constants";
import { closeModal } from "./dom";
import { t } from "../i18n";
import { epicDlProgress, patchLibraryCardDom, refreshGameActionUi } from "./game-view";
import { updateBadge } from "./nav";
import { pruneRecent, pushRecent } from "./recent";
import { notify, render } from "./render";
import { rawOf, setEpicSummaries } from "./selectors";
import { S } from "./state";
import { toast } from "./toast";
import { syncLibraryHeadingCount } from "../features/library/library-view";

/** Launch a game and record it in the recent list. */
export async function epicStop(appName: string): Promise<void> {
  try {
    const msg = await epicStopGame(appName);
    S.runningGames.delete(appName);
    toast(msg, "ok");
    refreshGameActionUi(appName);
  } catch (e) {
    toast(String(e), "err");
  }
}

export async function epicPlay(appName: string): Promise<void> {
  pushRecent(appName);
  toast(t("dl.launching"), "");
  try {
    const msg = await epicLaunchGame(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
}

/** Start (or update) a game installation, wiring up the download metrics. */
export async function epicInstall(appName: string, installDir?: string | null): Promise<void> {
  const s = S.epicSummariesMap.get(appName);
  if (!s || epicDlProgress(appName) !== null) return;
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
    toast(msg, "ok");
    S.dlQueueStatus = await epicGetQueue();
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
  try {
    const msg = await epicUninstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
  closeModal();
  await refreshEpicInstalled();
  if (S.view === "library") patchLibraryCardDom(appName);
}

/** Re-read the installed list from Legendary and refresh the UI. */
export async function refreshEpicInstalled(): Promise<void> {
  if (!isTauri) return;
  try {
    const [einstalled, eskipped] = await Promise.all([epicListInstalled(), epicListSkipped()]);
    setEpicSummaries(summarize(S.epicGamesRaw, einstalled, eskipped));
    pruneRecent();
    S.epicSkippedCount = eskipped.length;
    if (S.view === "library") {
      syncLibraryHeadingCount();
      updateBadge();
    }
    void refreshUpdates();
  } catch (e) {
    toast(t("lib.installedRefreshFailed", { msg: String(e) }), "err");
  }
}

/** Whether the first update sweep already ran (skip notifications for it). */
let updatesCheckedOnce = false;

/** Check for pending updates across all installed games. */
export async function refreshUpdates(): Promise<void> {
  if (!isTauri) return;
  try {
    const updates = await epicCheckUpdates();
    const firstRun = !updatesCheckedOnce;
    updatesCheckedOnce = true;
    const prev = new Set(S.availableUpdates.keys());
    S.availableUpdates.clear();
    for (const u of updates) {
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
