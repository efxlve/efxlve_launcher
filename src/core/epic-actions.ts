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
  epicListInstalled,
  epicListSkipped,
  epicUninstallGame,
  getThirdPartyLauncher,
  summarize,
} from "../epic";
import { isTauri } from "./constants";
import { closeModal } from "./dom";
import { t } from "../i18n";
import { epicDlProgress } from "./game-view";
import { updateBadge } from "./nav";
import { pruneRecent, pushRecent } from "./recent";
import { render, scheduleRender } from "./render";
import { rawOf, setEpicSummaries } from "./selectors";
import { S } from "./state";
import { toast } from "./toast";

/** Launch a game and record it in the recent list. */
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
export async function epicInstall(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s || epicDlProgress(appName) !== null) return;
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  if (partner) {
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
  void epicGetQueue().then((q) => {
    S.dlQueueStatus = q;
    if (S.view === "library" || S.view === "downloads") render();
  }).catch(() => {
    if (S.view === "library" || S.view === "downloads") render();
  });
  try {
    const msg = await epicInstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    toast(String(e), "err");
    if (S.view === "library" || S.view === "downloads") render();
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
}

/** Re-read the installed list from Legendary and refresh the UI. */
export async function refreshEpicInstalled(): Promise<void> {
  if (!isTauri) return;
  try {
    const [einstalled, eskipped] = await Promise.all([epicListInstalled(), epicListSkipped()]);
    setEpicSummaries(summarize(S.epicGamesRaw, einstalled, eskipped));
    pruneRecent();
    S.epicSkippedCount = eskipped.length;
    if (S.view === "library") scheduleRender();
    void refreshUpdates();
  } catch (e) {
    toast(`Kurulu listesi tazelenemedi: ${String(e)}`, "err");
  }
}

/** Check for pending updates across all installed games. */
export async function refreshUpdates(): Promise<void> {
  if (!isTauri) return;
  try {
    const updates = await epicCheckUpdates();
    S.availableUpdates.clear();
    for (const u of updates) {
      S.availableUpdates.set(u.appName, u);
    }
    if (S.availableUpdates.size > 0 && S.view === "library") {
      scheduleRender();
    }
  } catch (e) {
    console.warn("Update check could not be performed:", e);
  }
}
