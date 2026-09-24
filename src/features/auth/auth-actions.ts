/**
 * Epic account lifecycle and library synchronization.
 *
 * Boots the Legendary binary, hydrates the library from the instant disk cache,
 * runs background sync, and handles progressive login, import, and logout.
 */

import { isTauri } from "../../core/constants";
import { refreshUpdates } from "../../core/epic-actions";
import { pruneRecent } from "../../core/recent";
import { closeAllModals, render, scheduleRender } from "../../core/render";
import { setEpicGamesRaw, setEpicSummaries } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { localizeMessage, t } from "../../i18n";
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
  epicResumePendingDownload,
  epicSetScreenshotHotkey,
  epicSetupStatus,
  isNotAuth,
  summarize,
  type CachedLibrary,
} from "../../epic";
import { loadEpicCollections } from "../collections/collections-view";
import { updateAuthProgressUi } from "../accounts/accounts-view";

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
      S.epicAccount = "";
      S.epicPhase = "login";
      render();
      return;
    }
    S.epicAccount = cached.account;
    if (cached.collections && Array.isArray(cached.collections)) {
      S.epicCollections = cached.collections;
    }
    setEpicSummaries(summarize(cached.games, cached.installed, cached.skipped));
    pruneRecent();
    setEpicGamesRaw(cached.games);
    S.epicPhase = "library";
    render();
    void loadEpicAchSummaries();
    void loadEpicCollections();
    void refreshUpdates();
    void syncEpicLibrary(false);
    void epicResumePendingDownload().catch(() => {});
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

/** Extract authorizationCode value from raw string, quotes, full JSON response, or redirect URL. */
export function extractAuthCode(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "";

  // Strip leading/trailing wrapping quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // 1. If user pasted the whole JSON response from the browser
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed) {
      if (typeof parsed.authorizationCode === "string" && parsed.authorizationCode.trim()) {
        return parsed.authorizationCode.trim();
      }
      if (typeof parsed.redirectUrl === "string") {
        const urlMatch = parsed.redirectUrl.match(/[?&]code=([a-zA-Z0-9_-]+)/);
        if (urlMatch && urlMatch[1]) return urlMatch[1].trim();
      }
    }
  } catch {
    // Not valid JSON, continue to regex extractors
  }

  // 2. If user pasted the full redirectUrl or address bar with ?code= or &code=
  const urlParamMatch = trimmed.match(/[?&]code=([a-zA-Z0-9_-]+)/i);
  if (urlParamMatch && urlParamMatch[1]) {
    return urlParamMatch[1].trim();
  }

  // 3. Regex matching for "authorizationCode": "..." inside partial JSON copy-pastes
  const jsonCodeMatch = trimmed.match(/"?authorizationCode"?\s*[:=]\s*"?([a-zA-Z0-9_-]+)"?/i);
  if (jsonCodeMatch && jsonCodeMatch[1]) {
    return jsonCodeMatch[1].trim();
  }

  // 4. Return clean plain code without formatting quotes or commas
  return trimmed.replace(/[",;]/g, "").trim();
}

/**
 * Execute a cinematic, progressive login sequence.
 * Runs through 4 discrete stages: Auth -> Sync Catalog -> Trophies/Assets -> Console Ready.
 */
export async function runProgressiveAuth(
  actionName: "login" | "import",
  authCall: () => Promise<string>,
): Promise<void> {
  if (S.authLoading || S.epicBusy) return;
  S.authLoading = true;
  S.epicBusy = actionName;
  S.authStage = "authenticating";
  S.authProgress = 15;
  S.authStageText = t("auth.stageAuth");
  render();

  let timer: number | null = null;
  try {
    // Stage 1: Auth call in flight — smooth progress up to 38%
    timer = window.setInterval(() => {
      if (S.authProgress < 38) {
        S.authProgress += 3;
        updateAuthProgressUi();
      }
    }, 120);

    const account = await authCall();
    if (timer) clearInterval(timer);
    S.epicAccount = account;
    S.authProgress = 42;
    updateAuthProgressUi();

    // Stage 2: Syncing library & catalog
    S.authStage = "syncing";
    S.authStageText = t("auth.stageSync");
    S.authProgress = 52;
    updateAuthProgressUi();

    // Human perception delay
    await new Promise((r) => setTimeout(r, 450));

    const cached: CachedLibrary = await epicCachedLibrary();
    S.epicSkippedCount = cached.skipped.length;
    setEpicSummaries(summarize(cached.games, cached.installed, cached.skipped));
    pruneRecent();
    setEpicGamesRaw(cached.games);

    S.authProgress = 72;
    updateAuthProgressUi();
    await new Promise((r) => setTimeout(r, 400));

    // Stage 3: Achievements, trophies and collections
    S.authStage = "trophies";
    S.authStageText = t("auth.stageTrophies");
    S.authProgress = 88;
    updateAuthProgressUi();

    void loadEpicAchSummaries();
    void loadEpicCollections();
    void refreshUpdates();

    await new Promise((r) => setTimeout(r, 450));

    // Stage 4: Console launch ready
    S.authStage = "ready";
    S.authStageText = t("auth.stageReady");
    S.authProgress = 100;
    updateAuthProgressUi();

    await new Promise((r) => setTimeout(r, 500));

    // Complete & smooth reveal of the main library view
    S.authLoading = false;
    S.epicBusy = "";
    S.epicPhase = "library";
    S.accountsAddMode = false;
    S.view = "library";
    render();

    toast(t("auth.signedIn", { name: S.epicAccount ?? "" }), "ok");
    void syncEpicLibrary(false);
    void epicResumePendingDownload().catch(() => {});
  } catch (e) {
    if (timer) clearInterval(timer);
    S.authLoading = false;
    S.epicBusy = "";
    S.authProgress = 0;
    S.epicPhase = "login";
    render();
    toast(
      t(actionName === "login" ? "auth.signInFailed" : "auth.importFailed", {
        msg: cleanAuthError(e),
      }),
      "err",
    );
  }
}

/** Translate raw CLI/legendary auth errors into human-friendly messages. */
export function cleanAuthError(err: unknown): string {
  const msg = String(err);
  if (
    msg.includes("No EGS login session") ||
    msg.includes("AppData path does not exist") ||
    msg.includes("EGS AppData") ||
    msg.includes("ValueError")
  ) {
    return t("auth.egsNotFound");
  }
  if (
    msg.includes("Invalid authorization code") ||
    msg.includes("400 Bad Request") ||
    msg.includes("invalid_grant") ||
    msg.includes("errors.com.epicgames")
  ) {
    return t("auth.invalidCode");
  }
  return localizeMessage(msg);
}

export async function epicDoLogin(code: string): Promise<void> {
  const cleanCode = extractAuthCode(code);
  if (!cleanCode) {
    toast(t("auth.pasteFailed"), "err");
    return;
  }
  await runProgressiveAuth("login", () => epicLoginWithCode(cleanCode));
}

export async function epicDoImport(): Promise<void> {
  await runProgressiveAuth("import", () => epicImportEgl());
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
  S.view = "library";
  S.epicPhase = "login";
  closeAllModals();
  render();
}
