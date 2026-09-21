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
import {
  epicCachedLibrary,
  epicEnsureBinary,
  epicGetAchievementsSummary,
  epicGetSteamGridKey,
  epicImportEgl,
  epicImportEglCollections,
  epicListGames,
  epicListInstalled,
  epicListSkipped,
  epicLoginWithCode,
  epicLogout,
  epicSetScreenshotHotkey,
  epicSetupStatus,
  epicStatus,
  isNotAuth,
  summarize,
  type CachedLibrary,
} from "../../epic";
import { loadEpicCollections } from "../collections/collections-view";
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
    void refreshUpdates();
    void syncEpicLibrary(false);
  } catch (e) {
    S.epicPhase = "error";
    S.epicError = String(e);
    render();
  }
}

export async function loadEpicAchSummaries(): Promise<void> {
  if (!isTauri) return;
  try {
    S.epicAchSummaries = await epicGetAchievementsSummary();
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Başarım özetleri alınamadı:", e);
  }
}

/** Arka plan senkronu */
export async function syncEpicLibrary(manual: boolean): Promise<void> {
  if (!isTauri || S.epicSyncing) return;
  S.epicSyncing = true;
  if (manual) {
    S.epicBusyMsg = "Kütüphane senkronize ediliyor…";
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
      toast("Kütüphane ve koleksiyonlar güncellendi", "ok");
    } else {
      void loadEpicCollections();
    }
  } catch (e) {
    if (isNotAuth(e)) {
      S.epicPhase = "login";
    } else {
      S.epicSyncNote = "Çevrimdışı önbellek gösteriliyor — senkron başarısız oldu.";
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
    toast("legendary hazır", "ok");
    await refreshEpic();
  } catch (e) {
    toast(`İndirme başarısız: ${String(e)}`, "err");
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
    toast(`${S.epicAccount} olarak giriş yapıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Giriş başarısız: ${String(e)}`, "err");
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
    toast(`${S.epicAccount} oturumu aktarıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Aktarma başarısız: ${String(e)}`, "err");
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



