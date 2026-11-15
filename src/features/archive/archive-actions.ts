/**
 * Media archive actions: plan, pack, scan a folder, restore and keep the
 * progress panel alive without repainting the whole settings page.
 */

import { S } from "../../core/state";
import { scheduleRender } from "../../core/render";
import { toast } from "../../core/toast";
import { ARCHIVE_XTOOL_KEY } from "../../core/constants";
import type { LibraryItem } from "../../core/types";
import { fmtBytes, fmtSpeed } from "../../core/utils";
import { t, localizeMessage } from "../../i18n";
import { epicOpenFolderPath, epicSelectFolderDialog } from "../../epic";
import { findArchiveGame, pickArchiveGame } from "./archive-selection";
import {
  archiveCancel,
  archiveDefaultTarget,
  archiveDiscs,
  archiveEstimate,
  archiveLocate,
  archivePlan,
  archiveProfiles,
  archiveRestore,
  archiveScanFolder,
  archiveStart,
  archiveXtoolInstall,
  discBurnFolder,
  discListRecorders,
  type ArchiveProgress,
  type FoundArchive,
} from "../../archive";

let planToken = 0;
let planTimer: number | undefined;
let planInFlightKey = "";
let estimateToken = 0;
let bootPromise: Promise<void> | null = null;
let bootKey = "";

export function archiveGameList(): LibraryItem[] {
  const seen = new Set<string>();
  const games: LibraryItem[] = [];
  for (const item of S.allGamesMap.values()) {
    if (!item.installed || !item.installPath || seen.has(item.key)) continue;
    seen.add(item.key);
    games.push(item);
  }
  return games.sort((left, right) => left.title.localeCompare(right.title));
}

export function selectedArchiveGame(): LibraryItem | undefined {
  return pickArchiveGame(archiveGameList(), S.archiveSelectedApp);
}

export function archiveStageLabel(stage: string): string {
  switch (stage) {
    case "scanning":
      return t("archive.stageScanning");
    case "compressing":
      return t("archive.stageCompressing");
    case "finalizing":
      return t("archive.stageFinalizing");
    case "restoring":
      return t("archive.stageRestoring");
    case "registering":
      return t("archive.stageRegistering");
    case "done":
      return t("archive.stageDone");
    case "failed":
      return t("archive.stageFailed");
    default:
      return stage;
  }
}

function fmtBytesOrZero(bytes: number): string {
  return bytes > 0 ? fmtBytes(bytes) : "0 B";
}

function fmtEta(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds >= 3600) {
    return t("archive.etaHours", {
      h: Math.floor(seconds / 3600),
      m: Math.floor((seconds % 3600) / 60),
    });
  }
  if (seconds >= 60) {
    return t("archive.etaMinutes", {
      m: Math.floor(seconds / 60),
      s: seconds % 60,
    });
  }
  return t("archive.etaSeconds", { s: seconds });
}

/** Called when the Archive section opens; it is safe to call on every paint. */
export function loadArchiveView(): void {
  if (bootPromise) return;
  const game = selectedArchiveGame();
  const key = `${game?.key ?? ""}|${S.archiveTab}|${S.archiveProfile}|${S.archiveCustomMib}|${S.archiveTarget}`;
  if (bootKey === key) return;
  bootKey = key;
  bootPromise = ensureArchiveSelection()
    .catch(() => {
      bootKey = "";
    })
    .finally(() => {
      bootPromise = null;
      scheduleRender();
    });
}

async function ensureArchiveSelection(): Promise<void> {
  if (!S.archiveProfiles) {
    try {
      S.archiveProfiles = await archiveProfiles();
    } catch {
      S.archiveProfiles = [];
    }
  }
  const games = archiveGameList();
  if (!games.length) return;
  if (
    !games.some(
      (game) => game.key === S.archiveSelectedApp || game.id === S.archiveSelectedApp,
    )
  ) {
    S.archiveSelectedApp = games[0].key;
    S.archivePlan = null;
    S.archiveTarget = "";
  }
  if (!S.archiveTarget) {
    await applyDefaultTarget(selectedArchiveGame());
  }
  if (S.archiveTab === "backup") await loadArchivePlan();
}

async function applyDefaultTarget(game: LibraryItem | undefined): Promise<void> {
  if (!game) return;
  try {
    const target = await archiveDefaultTarget(game.key, game.installPath ?? "");
    S.archiveTarget = target.targetParent;
  } catch {
    S.archiveTarget = "";
  }
}

export async function loadArchivePlan(): Promise<void> {
  const game = selectedArchiveGame();
  if (!game || !game.installPath) {
    S.archivePlan = null;
    S.archivePlanLoading = false;
    return;
  }
  if (planTimer !== undefined) {
    window.clearTimeout(planTimer);
    planTimer = undefined;
  }
  const key = `${game.key}|${S.archiveProfile}|${S.archiveCustomMib}|${S.archiveTarget}`;
  if (planInFlightKey === key) return;
  planInFlightKey = key;
  const token = ++planToken;
  S.archivePlanLoading = true;
  scheduleRender();
  try {
    const plan = await archivePlan({
      appName: game.key,
      title: game.title,
      installPath: game.installPath,
      targetRoot: S.archiveTarget,
      profileId: S.archiveProfile,
      customMib: S.archiveCustomMib,
    });
    if (token !== planToken) return;
    S.archivePlan = plan;
    if (!S.archiveTarget) S.archiveTarget = plan.targetRoot;
  } catch {
    if (token === planToken) S.archivePlan = null;
  } finally {
    if (planInFlightKey === key) planInFlightKey = "";
    if (token === planToken) {
      S.archivePlanLoading = false;
      scheduleRender();
    }
  }
}

function schedulePlan(): void {
  if (planTimer !== undefined) window.clearTimeout(planTimer);
  planTimer = window.setTimeout(() => {
    planTimer = undefined;
    void loadArchivePlan();
  }, 300);
}

/** The estimate is tied to one game, profile and level; any change drops it. */
function invalidateEstimate(): void {
  estimateToken += 1;
  S.archiveEstimate = null;
  S.archiveEstimating = false;
}

export async function requestEstimate(): Promise<void> {
  const game = selectedArchiveGame();
  if (!game || !game.installPath || S.archiveEstimating) return;
  const token = ++estimateToken;
  S.archiveEstimating = true;
  S.archiveEstimate = null;
  scheduleRender();
  try {
    const estimate = await archiveEstimate({
      installPath: game.installPath,
      profileId: S.archiveProfile,
      customMib: S.archiveCustomMib,
      level: S.archiveLevel,
    });
    if (token === estimateToken) S.archiveEstimate = estimate;
  } catch (error) {
    if (token === estimateToken) toast(localizeMessage(String(error)), "err");
  } finally {
    if (token === estimateToken) {
      S.archiveEstimating = false;
      scheduleRender();
    }
  }
}

async function pickFolder(current: string): Promise<string | null> {
  try {
    return await epicSelectFolderDialog(current || null, t("archive.chooseFolder"));
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
    return null;
  }
}

/** xtool ships as `xtool.exe` next to its `_libraries` folder. */
function xtoolExecutable(folder: string): string {
  const separator = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}xtool.exe`;
}

function setXtoolPath(value: string): void {
  S.archiveXtoolPath = value;
  try {
    localStorage.setItem(ARCHIVE_XTOOL_KEY, value);
  } catch {
    // Storage blocked: the path still applies for this session.
  }
}

async function installXtool(): Promise<void> {
  if (S.archiveXtoolInstalling) return;
  S.archiveXtoolInstalling = true;
  scheduleRender();
  try {
    const path = await archiveXtoolInstall();
    setXtoolPath(path);
    toast(t("archive.xtoolInstalled"), "ok");
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  } finally {
    S.archiveXtoolInstalling = false;
    scheduleRender();
  }
}

export function onArchiveProgress(progress: ArchiveProgress): void {
  S.archiveProgress = progress;
  if (progress.stage === "done") {
    S.archiveRunning = false;
    scheduleRender();
    return;
  }
  if (progress.stage === "failed") {
    // The command's rejection handler owns the final state; a failure event
    // alone must not re-enable the button while it is still cleaning up.
    scheduleRender();
    return;
  }
  updateArchiveProgressInPlace(progress);
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function updateArchiveProgressInPlace(progress: ArchiveProgress): void {
  setText("archive-progress-stage", archiveStageLabel(progress.stage));
  setText("archive-progress-percent", `${progress.percent.toFixed(1)}%`);
  const fill = document.getElementById("archive-progress-fill");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
  setText(
    "archive-progress-bytes",
    `${fmtBytesOrZero(progress.processedBytes)} / ${fmtBytesOrZero(progress.totalBytes)}`,
  );
  setText("archive-progress-speed", progress.speedBytes ? fmtSpeed(progress.speedBytes) : "");
  setText(
    "archive-progress-eta",
    progress.etaSeconds ? t("archive.eta", { eta: fmtEta(progress.etaSeconds) }) : "",
  );
  setText("archive-progress-file", progress.currentFile);
  setText(
    "archive-progress-volume",
    progress.volume ? t("archive.volumeN", { n: progress.volume }) : "",
  );
}

export function openArchiveForGame(appName: string): void {
  // The manage panel passes an Epic appName (`Ginger`), while the archive list
  // keys every game (`epic::Ginger`). Resolve it before the view falls back to
  // the first installed game.
  const item = findArchiveGame(archiveGameList(), appName);
  S.archiveSelectedApp = item?.key ?? appName;
  S.archiveTab = "backup";
  S.archivePlan = null;
  S.archiveResult = null;
  S.archiveProgress = null;
  S.archiveTarget = "";
  S.archiveRunning = false;
  invalidateEstimate();
  clearBurnState();
  loadArchiveView();
}

function clearBurnState(): void {
  S.archiveDiscs = null;
  S.archiveDiscsManifest = "";
  S.archiveDiscsLoading = false;
  S.archiveBurnDone = null;
  S.archiveBurning = null;
}

export async function loadArchiveDiscs(manifestPath: string): Promise<void> {
  if (!manifestPath) return;
  S.archiveDiscsManifest = manifestPath;
  S.archiveDiscsLoading = true;
  scheduleRender();
  try {
    const discs = await archiveDiscs(manifestPath);
    if (S.archiveDiscsManifest !== manifestPath) return;
    S.archiveDiscs = discs;
  } catch (error) {
    if (S.archiveDiscsManifest === manifestPath) {
      S.archiveDiscs = [];
      toast(localizeMessage(String(error)), "err");
    }
  } finally {
    if (S.archiveDiscsManifest === manifestPath) {
      S.archiveDiscsLoading = false;
      scheduleRender();
    }
  }
}

export async function loadBurnRecorders(force = false): Promise<void> {
  if (S.archiveBurnRecorders && !force) return;
  try {
    const recorders = await discListRecorders();
    S.archiveBurnRecorders = recorders;
    if (!recorders.some((recorder) => recorder.id === S.archiveBurnRecorder)) {
      S.archiveBurnRecorder = recorders[0]?.id ?? "";
    }
  } catch (error) {
    S.archiveBurnRecorders = [];
    S.archiveBurnRecorder = "";
    toast(localizeMessage(String(error)), "err");
  }
  scheduleRender();
}

async function burnDisc(folder: string, index: number): Promise<void> {
  if (!folder || S.archiveBurning !== null || S.archiveRunning) return;
  const recorder = S.archiveBurnRecorder;
  if (!recorder) {
    toast(t("archive.burnNoRecorder"), "err");
    return;
  }
  S.archiveBurning = index;
  S.archiveBurnDone = null;
  scheduleRender();
  try {
    await discBurnFolder(folder, recorder);
    S.archiveBurnDone = index;
    toast(t("archive.burnDone"), "ok");
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  } finally {
    S.archiveBurning = null;
    scheduleRender();
  }
}

async function startBackup(): Promise<void> {
  const game = selectedArchiveGame();
  if (!game || !game.installPath || S.archiveRunning) return;
  if (S.archiveBurning !== null) {
    toast(t("archive.burnInProgress"), "err");
    return;
  }
  if (S.runningGames.has(game.key)) {
    toast(t("archive.gameRunning"), "err");
    return;
  }
  S.archiveRunning = true;
  S.archiveProgress = null;
  S.archiveResult = null;
  clearBurnState();
  scheduleRender();
  try {
    const result = await archiveStart({
      appName: game.key,
      title: game.title,
      installPath: game.installPath,
      targetRoot: S.archiveTarget,
      profileId: S.archiveProfile,
      customMib: S.archiveCustomMib,
      level: S.archiveLevel,
      xtoolPath: S.archiveXtoolPath,
    });
    S.archiveResult = result;
    S.archiveProgress = null;
    if (result.discLayout) {
      void loadArchiveDiscs(result.manifestPath);
      void loadBurnRecorders(true);
    }
    toast(t("archive.backupDone"), "ok");
  } catch (error) {
    const raw = String(error);
    if (raw.includes("archive.cancelled")) {
      S.archiveProgress = null;
    } else {
      toast(localizeMessage(raw), "err");
    }
  } finally {
    S.archiveRunning = false;
    scheduleRender();
  }
}

async function scanSource(): Promise<void> {
  const root = S.archiveSource.trim();
  if (!root) {
    toast(t("archive.sourceMissing"), "err");
    return;
  }
  S.archiveFoundLoading = true;
  scheduleRender();
  try {
    const found = await archiveScanFolder(root);
    S.archiveFound = found;
    clearBurnState();
    const current = found.find((item) => item.manifestPath === S.archiveSelectedManifest);
    if (!current) {
      S.archiveSelectedManifest = found[0]?.manifestPath ?? "";
      S.archiveExtraDirs = [];
      S.archiveRestoreResult = null;
      if (found[0]) await applyRestoreDefaults(found[0]);
    }
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  } finally {
    S.archiveFoundLoading = false;
    scheduleRender();
  }
}

async function applyRestoreDefaults(found: FoundArchive): Promise<void> {
  try {
    const target = await archiveDefaultTarget(
      found.manifest.appName,
      found.manifest.originalInstallPath,
    );
    S.archiveRestoreTarget = target.targetParent;
  } catch {
    S.archiveRestoreTarget = "";
  }
}

async function selectFound(manifestPath: string): Promise<void> {
  const found = S.archiveFound?.find((item) => item.manifestPath === manifestPath);
  if (!found) return;
  S.archiveSelectedManifest = manifestPath;
  S.archiveExtraDirs = [];
  S.archiveRestoreResult = null;
  clearBurnState();
  await applyRestoreDefaults(found);
  scheduleRender();
}

async function addPartsFolder(): Promise<void> {
  const found = S.archiveFound?.find(
    (item) => item.manifestPath === S.archiveSelectedManifest,
  );
  if (!found) return;
  const folder = await pickFolder(S.archiveSource);
  if (!folder) return;
  if (!S.archiveExtraDirs.includes(folder)) S.archiveExtraDirs.push(folder);
  try {
    const missing = await archiveLocate(found.manifestPath, S.archiveExtraDirs);
    found.missingVolumes = missing;
    if (!missing.length) toast(t("archive.partsReadyToast"), "ok");
    else toast(t("archive.partsStillMissing", { count: missing.length }), "err");
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
  scheduleRender();
}

/** The store record changed on disk; reload the matching library view so the
 *  game stops looking uninstalled. A failed refresh never fails the restore. */
async function refreshAfterRestore(store: string): Promise<void> {
  try {
    const module = await import("./archive-refresh");
    await module.refreshAfterRestore(store);
  } catch {
    // The files and the store record are already in place.
  }
  scheduleRender();
}

async function startRestore(): Promise<void> {
  const found = S.archiveFound?.find(
    (item) => item.manifestPath === S.archiveSelectedManifest,
  );
  if (!found || S.archiveRunning) return;
  if (S.archiveBurning !== null) {
    toast(t("archive.burnInProgress"), "err");
    return;
  }
  if (S.runningGames.has(found.manifest.appName)) {
    toast(t("archive.gameRunning"), "err");
    return;
  }
  if (found.missingVolumes.length) {
    const list = found.missingVolumes
      .map(
        (index) =>
          found.manifest.volumes.find((volume) => volume.index === index)?.fileName ??
          String(index),
      )
      .join(", ");
    toast(t("archive.missingList", { list }), "err");
    return;
  }
  if (!S.archiveRestoreTarget.trim()) {
    toast(t("archive.invalidTarget"), "err");
    return;
  }
  S.archiveRunning = true;
  S.archiveProgress = null;
  S.archiveRestoreResult = null;
  scheduleRender();
  try {
    const result = await archiveRestore({
      manifestPath: found.manifestPath,
      targetParent: S.archiveRestoreTarget.trim(),
      extraDirs: S.archiveExtraDirs,
      overwrite: S.archiveOverwrite,
      xtoolPath: S.archiveXtoolPath,
    });
    S.archiveRestoreResult = result;
    S.archiveProgress = null;
    void refreshAfterRestore(found.manifest.store);
    toast(t("archive.restoreDone"), "ok");
  } catch (error) {
    const raw = String(error);
    if (raw.includes("archive.cancelled")) {
      S.archiveProgress = null;
    } else {
      toast(localizeMessage(raw), "err");
    }
  } finally {
    S.archiveRunning = false;
    scheduleRender();
  }
}

/** Click actions handled by the central router. */
export function handleArchiveAction(
  act: string | undefined,
  _id: string | undefined,
  target: HTMLElement,
): boolean {
  if (act === "archive-tab") {
    const tab = target.dataset.tab;
    S.archiveTab = tab === "restore" || tab === "guide" ? tab : "backup";
    scheduleRender();
    return true;
  }
  if (act === "archive-profile") {
    const profile = target.dataset.profile || "fat32";
    if (profile !== S.archiveProfile) {
      S.archiveProfile = profile;
      S.archivePlan = null;
      S.archiveResult = null;
      invalidateEstimate();
      schedulePlan();
      scheduleRender();
    }
    return true;
  }
  if (act === "archive-estimate") {
    void requestEstimate();
    return true;
  }
  if (act === "archive-pick-target") {
    void pickFolder(S.archiveTarget).then((folder) => {
      if (!folder) return;
      S.archiveTarget = folder;
      S.archivePlan = null;
      S.archiveResult = null;
      void loadArchivePlan();
    });
    return true;
  }
  if (act === "archive-pick-xtool") {
    const parent = S.archiveXtoolPath.replace(/[\\/][^\\/]*$/, "");
    void pickFolder(parent).then((folder) => {
      if (!folder) return;
      setXtoolPath(xtoolExecutable(folder));
      scheduleRender();
    });
    return true;
  }
  if (act === "archive-xtool-install") {
    void installXtool();
    return true;
  }
  if (act === "archive-start") {
    void startBackup();
    return true;
  }
  if (act === "archive-cancel") {
    const id = S.archiveProgress?.id || S.archiveSelectedApp;
    void archiveCancel(id).then((cancelled) => {
      if (cancelled) toast(t("archive.cancelling"), "ok");
    });
    return true;
  }
  if (act === "archive-open-folder") {
    const path = target.dataset.path || S.archiveResult?.folder || S.archiveRestoreResult?.target || "";
    if (path) void epicOpenFolderPath(path).catch((error: unknown) => toast(String(error), "err"));
    return true;
  }
  if (act === "archive-pick-source") {
    void pickFolder(S.archiveSource).then((folder) => {
      if (!folder) return;
      S.archiveSource = folder;
      scheduleRender();
      void scanSource();
    });
    return true;
  }
  if (act === "archive-scan") {
    void scanSource();
    return true;
  }
  if (act === "archive-select-found") {
    const manifestPath = target.dataset.manifest || "";
    if (manifestPath) void selectFound(manifestPath);
    return true;
  }
  if (act === "archive-add-parts") {
    void addPartsFolder();
    return true;
  }
  if (act === "archive-burn-load") {
    const manifestPath = target.dataset.manifest || S.archiveSelectedManifest;
    void loadArchiveDiscs(manifestPath);
    void loadBurnRecorders();
    return true;
  }
  if (act === "archive-burn-refresh") {
    void loadBurnRecorders(true);
    return true;
  }
  if (act === "archive-burn") {
    const folder = target.dataset.folder || "";
    const index = Number(target.dataset.index) || 0;
    void burnDisc(folder, index);
    return true;
  }
  if (act === "archive-pick-restore-target") {
    void pickFolder(S.archiveRestoreTarget).then((folder) => {
      if (folder) {
        S.archiveRestoreTarget = folder;
        scheduleRender();
      }
    });
    return true;
  }
  if (act === "archive-restore-start") {
    void startRestore();
    return true;
  }
  return false;
}

/** Change events (selects, text inputs and checkboxes). */
export function handleArchiveChange(target: HTMLElement): boolean {
  const act = target.dataset.act;
  if (!act?.startsWith("archive-")) return false;
  if (act === "archive-select-game") {
    const value = (target as HTMLSelectElement).value;
    if (value && value !== S.archiveSelectedApp) {
      S.archiveSelectedApp = value;
      S.archivePlan = null;
      S.archiveResult = null;
      S.archiveTarget = "";
      invalidateEstimate();
      scheduleRender();
      void ensureArchiveSelection();
    }
    return true;
  }
  if (act === "archive-level") {
    const value = (target as HTMLSelectElement).value;
    S.archiveLevel = value === "fast" || value === "max" ? value : "balanced";
    invalidateEstimate();
    scheduleRender();
    return true;
  }
  if (act === "archive-custom-mib") {
    const value = Number((target as HTMLInputElement).value);
    S.archiveCustomMib = Math.max(16, Math.min(1_000_000, Math.round(value) || 8_000));
    S.archivePlan = null;
    S.archiveResult = null;
    invalidateEstimate();
    schedulePlan();
    scheduleRender();
    return true;
  }
  if (act === "archive-target-input") {
    S.archiveTarget = (target as HTMLInputElement).value;
    S.archivePlan = null;
    S.archiveResult = null;
    schedulePlan();
    return true;
  }
  if (act === "archive-xtool-input") {
    setXtoolPath((target as HTMLInputElement).value);
    return true;
  }
  if (act === "archive-source-input") {
    S.archiveSource = (target as HTMLInputElement).value;
    return true;
  }
  if (act === "archive-restore-target-input") {
    S.archiveRestoreTarget = (target as HTMLInputElement).value;
    scheduleRender();
    return true;
  }
  if (act === "archive-overwrite") {
    S.archiveOverwrite = (target as HTMLInputElement).checked;
    return true;
  }
  if (act === "archive-burn-recorder") {
    S.archiveBurnRecorder = (target as HTMLSelectElement).value;
    return true;
  }
  return false;
}


