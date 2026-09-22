/**
 * Epic account lifecycle and library synchronization.
 *
 * Boots the Legendary binary, hydrates the library from the instant disk cache,
 * runs background sync, and handles login/import/logout.
 */

import { isTauri } from "../../core/constants";
import { refreshUpdates } from "../../core/epic-actions";
import { pruneRecent } from "../../core/recent";
import { render, scheduleRender } from "../../core/render";
import { setEpicGamesRaw, setEpicSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { localizeMessage, t } from "../../i18n";
import { epicCachedLibrary, epicEnsureBinary, epicGetAchievementsSummary, epicGetSteamGridKey, epicImportEgl, epicImportEglCollections, epicListGames, epicListInstalled, epicListSkipped, epicLoginWithCode, epicLogout, epicSetScreenshotHotkey, epicSetupStatus, isNotAuth, summarize, type CachedLibrary } from "../../epic";
import { loadEpicCollections } from "../collections/collections-view";
import { loadFreeGames } from "../freegames/freegames";
export async function bootEpic(): Promise<void> {
  if (!isTauri || S.epicBooted) return;
  S.epicBooted = true;
  void epicGetSteamGridKey().then((k) => { S.steamGridApiKey = k; }).catch(() => {});
  if (S.screenshotHotkey && S.screenshotHotkey > 0) {
    void epicSetScreenshotHotkey(S.screenshotHotkey).catch(() => {});
  }
  await refreshEpic();
}

export async function refreshEpic(): Promise<void> {
  if (!isTauri) {
    render();
    return;
  }
  S.epicPhase = "checking";
  S.epicError = "";
  S.epicBusyMsg = "";
  S.epicSyncNote = "";
  render();
  try {
    S.setupInfo = await epicSetupStatus();
    if (S.setupInfo.needsDownload) {
      S.epicPhase = "setup";
      render();
      return;
    }
    const cached: CachedLibrary = await epicCachedLibrary();
    S.epicSkippedCount = cached.skipped.length;
    if (!cached.account) {
      S.epicPhase = "login";
      render();
      return;
    }
    S.epicAccount = cached.account;
    setEpicSummaries(summarize(cached.games, cached.installed, cached.skipped));
    pruneRecent();
    setEpicGamesRaw(cached.games);
    S.epicPhase = "library";
    render();
    void loadEpicAchSummaries();
    void loadEpicCollections();
    void loadFreeGames();
    void refreshUpdates();
    void syncEpicLibrary(false);
  } catch (e) {
    S.epicPhase = "error";
    S.epicError = localizeMessage(String(e));
    render();
  }
}

export async function loadEpicAchSummaries(): Promise<void> {
  if (!isTauri) return;
  try {
    S.epicAchSummaries = await epicGetAchievementsSummary();
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Achievement summaries could not be fetched:", e);
  }
}

/** Background sync. */
export async function syncEpicLibrary(manual: boolean): Promise<void> {
  if (!isTauri || S.epicSyncing) return;
  S.epicSyncing = true;
  if (manual) {
    S.epicBusyMsg = t("lib.syncing");
    if (S.view === "library") render();
  }
  try {
    const [egames, einstalled, eskipped] = await Promise.all([
      epicListGames(),
      epicListInstalled(),
      epicListSkipped(),
    ]);
    setEpicSummaries(summarize(egames, einstalled, eskipped));
    pruneRecent();
    setEpicGamesRaw(egames);
    S.epicSkippedCount = eskipped.length;
    S.epicSyncNote = "";
    S.epicBusyMsg = "";
    void loadEpicAchSummaries();
    void refreshUpdates();
    if (manual) {
      try {
        S.epicCollections = await epicImportEglCollections();
      } catch {
        void loadEpicCollections();
      }
      toast(t("lib.updated"), "ok");
    } else {
      void loadEpicCollections();
    }
  } catch (e) {
    if (isNotAuth(e)) {
      S.epicPhase = "login";
    } else {
      S.epicSyncNote = t("lib.offlineCache");
    }
  } finally {
    S.epicSyncing = false;
    S.epicBusyMsg = "";
    if (S.view === "library") scheduleRender();
  }
}

export async function epicDownload(): Promise<void> {
  if (S.epicBusy) return;
  S.epicBusy = "download";
  S.setupProgress = 0;
  render();
  try {
    await epicEnsureBinary();
    toast(t("auth.legendaryReady"), "ok");
    await refreshEpic();
  } catch (e) {
    toast(t("auth.downloadFailed", { msg: localizeMessage(String(e)) }), "err");
  } finally {
    S.epicBusy = "";
    S.setupProgress = null;
    if (S.view === "library") render();
  }
}

export async function epicDoLogin(code: string): Promise<void> {
  if (!code.trim() || S.epicBusy) return;
  S.epicBusy = "login";
  render();
  try {
    S.epicAccount = await epicLoginWithCode(code);
    S.onboardingStep = 1;
    toast(t("auth.signedIn", { name: S.epicAccount ?? "" }), "ok");
    await refreshEpic();
  } catch (e) {
    toast(t("auth.signInFailed", { msg: localizeMessage(String(e)) }), "err");
  } finally {
    S.epicBusy = "";
    if (S.view === "library") render();
  }
}

export async function epicDoImport(): Promise<void> {
  if (S.epicBusy) return;
  S.epicBusy = "import";
  render();
  try {
    S.epicAccount = await epicImportEgl();
    S.onboardingStep = 1;
    toast(t("auth.imported", { name: S.epicAccount ?? "" }), "ok");
    await refreshEpic();
  } catch (e) {
    toast(t("auth.importFailed", { msg: localizeMessage(String(e)) }), "err");
  } finally {
    S.epicBusy = "";
    if (S.view === "library") render();
  }
}

export async function epicDoLogout(): Promise<void> {
  try {
    const msg = await epicLogout();
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
  S.epicAccount = "";
  setEpicSummaries([]);
  setEpicGamesRaw([]);
  S.epicSkippedCount = 0;
  await refreshEpic();
}



