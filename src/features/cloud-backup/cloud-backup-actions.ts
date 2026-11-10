/**
 * Cloud Save Backup actions: settings synchronization, authentication,
 * upload, download, and listing.
 */

import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { scheduleRender } from "../../core/render";
import { askConfirm } from "../../core/confirm-dialog";
import { fmtCloudDate, updateManageCloudRowInPlace } from "./cloud-backup-view";
import { askRestorePreview } from "./restore-preview-dialog";
import {
  cloudGameTitle,
  notifyBulkCloudBackupDone,
  notifyBulkCloudRestoreDone,
  notifyCloudRestoreDone,
  notifyCloudRestoreFailed,
  notifyCloudUploadDone,
  notifyCloudUploadFailed,
  notifyLocalBackupSummary,
} from "./cloud-notify";
import {
  cloudBackupGetSettings,
  cloudBackupSaveSettings,
  cloudBackupTestConnection,
  cloudBackupSuggestFolders,
  cloudBackupStartGdriveAuth,
  cloudBackupDisconnectGdrive,
  cloudBackupUploadGame,
  cloudBackupListGame,
  cloudBackupDownloadGame,
  cloudBackupPreviewGame,
  cloudBackupApplyRestore,
  cloudBackupCancelRestore,
  cloudBackupDeleteRemote,
  cloudBackupRemoteHash,
  epicBackupExcluded,
  epicBackupSave,
  epicBackupSaveIfChanged,
  epicGetLocalBackupRoot,
  epicSetLocalBackupDir,
  type CloudBackupSettings,
  type CloudBackupEntry,
} from "../../epic";

export async function initCloudBackupSettings(): Promise<CloudBackupSettings | null> {
  try {
    const st = await cloudBackupGetSettings();
    S.cloudBackupSettings = st;
    return st;
  } catch {
    return null;
  }
}

/** Loads the local backup folder once; the settings view calls this on mount. */
export async function initLocalBackupRoot(): Promise<void> {
  if (S.localBackupRoot !== null) return;
  try {
    S.localBackupRoot = await epicGetLocalBackupRoot();
  } catch {
    S.localBackupRoot = { configured: "", effective: "" };
  }
  scheduleRender();
}

/** Saves a new local backup root; an empty path restores the default. */
export async function saveLocalBackupDirAction(path: string): Promise<void> {
  try {
    S.localBackupRoot = await epicSetLocalBackupDir(path.trim());
    toast(t("cloud.localDirSaved"), "ok");
    scheduleRender();
  } catch (error) {
    toast(String(error), "err");
  }
}

export async function updateCloudBackupSettings(
  patch: Partial<CloudBackupSettings>,
): Promise<boolean> {
  const current = S.cloudBackupSettings ?? {
    enabled: false,
    provider: "none",
    autoSyncOnGameExit: false,
    retentionCount: 0,
    localBackupDaily: false,
    lastLocalBackup: null,
    profileDailyUpload: false,
    lastProfileUpload: null,
    folderPath: "",
    webdavUrl: "",
    webdavUsername: "",
    webdavPassword: "",
    webdavAllowInvalidCert: false,
    rcloneRemote: "",
    gdriveClientId: null,
    gdriveClientSecret: null,
    gdriveFolderId: null,
    gdriveUserEmail: null,
    gdriveRefreshToken: null,
    lastSyncTime: null,
  };

  const updated: CloudBackupSettings = { ...current, ...patch };
  try {
    await cloudBackupSaveSettings(updated);
    S.cloudBackupSettings = updated;
    if (patch.provider && patch.provider !== current.provider) {
      S.cloudBackupsMap.clear();
      S.launcherProfileArchives = null;
    }
    scheduleRender();
    return true;
  } catch (err) {
    toast(String(err), "err");
    return false;
  }
}

export async function testCloudConnectionAction(): Promise<void> {
  if (!S.cloudBackupSettings) return;
  S.cloudBackupTesting = true;
  scheduleRender();
  try {
    const res = await cloudBackupTestConnection(S.cloudBackupSettings);
    toast(res, "ok");
  } catch (err) {
    toast(String(err), "err");
  } finally {
    S.cloudBackupTesting = false;
    scheduleRender();
  }
}

let folderSuggestionsLoading = false;

/** Detects OneDrive, Dropbox, MEGA, ... once for the Folder quick picks. */
export async function loadCloudFolderSuggestionsAction(): Promise<void> {
  if (S.cloudFolderSuggestions !== null || folderSuggestionsLoading) return;
  folderSuggestionsLoading = true;
  try {
    S.cloudFolderSuggestions = await cloudBackupSuggestFolders();
  } catch {
    S.cloudFolderSuggestions = [];
  } finally {
    folderSuggestionsLoading = false;
    scheduleRender();
  }
}

/** Selects a detected sync folder and verifies it without manual typing. */
export async function useCloudFolderSuggestionAction(path: string): Promise<void> {
  if (!path) return;
  const ok = await updateCloudBackupSettings({ folderPath: path });
  if (!ok) return;
  await testCloudConnectionAction();
}

let gdriveAuthBusy = false;

export async function startGoogleDriveAuthAction(): Promise<void> {
  if (gdriveAuthBusy) {
    toast(t("cloud.gdriveAlreadyOpen"), "");
    return;
  }
  gdriveAuthBusy = true;
  toast(t("cloud.gdriveOpeningBrowser"), "");
  try {
    const email = await cloudBackupStartGdriveAuth();
    toast(t("cloud.gdriveConnected", { email }), "ok");
    await initCloudBackupSettings();
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
  } finally {
    gdriveAuthBusy = false;
  }
}

export async function disconnectGoogleDriveAction(): Promise<void> {
  try {
    await cloudBackupDisconnectGdrive();
    if (S.cloudBackupSettings) {
      S.cloudBackupSettings.gdriveRefreshToken = null;
      S.cloudBackupSettings.gdriveUserEmail = null;
    }
    toast(t("cloud.gdriveDisconnected"), "ok");
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
  }
}

/** Installed games the launcher owns save backups for, one key per game. */
function managedInstalledGames(excluded: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of S.allGamesMap.values()) {
    if (!item.installed) continue;
    if (
      !["epic", "gog", "amazon", "custom", "steam", "ubisoft", "ea", "xbox", "battlenet"].includes(
        item.source,
      )
    ) {
      continue;
    }
    const key = item.source === "epic" ? item.id : item.key;
    if (excluded.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Backs up every installed game from the stores the launcher manages. */
export async function bulkCloudBackupAction(): Promise<void> {
  if (S.cloudBulkProgress) return;
  const games = managedInstalledGames(new Set(await epicBackupExcluded()));
  if (games.length === 0) {
    toast(t("cloud.bulkNone"), "");
    return;
  }
  S.cloudBulkProgress = { done: 0, total: games.length, failed: 0 };
  scheduleRender();
  let failed = 0;
  const failedTitles: string[] = [];
  for (const key of games) {
    try {
      await cloudBackupUploadGame(key);
    } catch (error) {
      if (!String(error).includes("backup.noSaveDir")) {
        failed += 1;
        failedTitles.push(cloudGameTitle(key));
      }
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  const total = games.length;
  S.cloudBulkProgress = null;
  scheduleRender();
  toast(t("cloud.bulkDone", { total, failed }), failed > 0 ? "err" : "ok");
  notifyBulkCloudBackupDone(total, failed, failedTitles);
}

/** Backs up every installed game to this PC, with no cloud provider involved. */
export async function bulkLocalBackupAction(): Promise<void> {
  if (S.cloudBulkProgress) return;
  const games = managedInstalledGames(new Set(await epicBackupExcluded()));
  if (games.length === 0) {
    toast(t("cloud.bulkNone"), "");
    return;
  }
  const total = games.length;
  S.cloudBulkProgress = { done: 0, total, failed: 0, local: true };
  scheduleRender();
  let failed = 0;
  const failedTitles: string[] = [];
  for (const key of games) {
    try {
      await epicBackupSave(key);
    } catch (error) {
      if (!String(error).includes("backup.noSaveDir")) {
        failed += 1;
        failedTitles.push(cloudGameTitle(key));
      }
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  S.cloudBulkProgress = null;
  scheduleRender();
  toast(t("cloud.bulkDone", { total, failed }), failed > 0 ? "err" : "ok");
  notifyLocalBackupSummary(total, failed, failedTitles, "cloud.localNowTitle");
}

/** Restores the newest cloud backup of every installed managed game. */
export async function bulkCloudRestoreAction(): Promise<void> {
  if (S.cloudBulkProgress) return;
  const games = managedInstalledGames();
  if (games.length === 0) {
    toast(t("cloud.bulkNone"), "");
    return;
  }
  const proceed = await askConfirm({
    title: t("cloud.bulkRestoreTitle"),
    body: t("cloud.bulkRestoreBody", { total: games.length }),
    confirm: t("cloud.bulkRestoreConfirm"),
    cancel: t("common.cancel"),
  });
  if (!proceed) return;
  S.cloudBulkProgress = { done: 0, total: games.length, failed: 0 };
  scheduleRender();
  let restored = 0;
  let failed = 0;
  const failedTitles: string[] = [];
  for (const key of games) {
    if (S.runningGames.has(key)) {
      failed += 1;
      failedTitles.push(cloudGameTitle(key));
      S.cloudBulkProgress.done += 1;
      S.cloudBulkProgress.failed = failed;
      scheduleRender();
      continue;
    }
    try {
      const backups = await cloudBackupListGame(key);
      const latest = backups?.[0];
      if (latest) {
        await cloudBackupDownloadGame(key, latest.remoteId, latest.backupId);
        restored += 1;
      }
    } catch {
      failed += 1;
      failedTitles.push(cloudGameTitle(key));
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  S.cloudBulkProgress = null;
  scheduleRender();
  toast(t("cloud.bulkRestoreDone", { total: restored, failed }), failed > 0 ? "err" : "ok");
  notifyBulkCloudRestoreDone(restored, failed, failedTitles);
}

let localBackupTimer: number | null = null;

/** Starts the once-a-day local backup loop. Safe to call more than once. */
export function scheduleLocalBackups(): void {
  if (localBackupTimer !== null) return;
  const run = () => {
    void runScheduledLocalBackup();
  };
  // Let the library hydrate before the first pass, then check every six hours.
  window.setTimeout(run, 30_000);
  localBackupTimer = window.setInterval(run, 6 * 60 * 60 * 1000);
}

/** Runs the due check immediately, e.g. right after the switch is enabled. */
export function runScheduledLocalBackupNow(): void {
  void runScheduledLocalBackup();
}

async function runScheduledLocalBackup(): Promise<void> {
  const st = S.cloudBackupSettings;
  if (!st?.localBackupDaily || S.cloudBulkProgress) return;
  const now = Math.floor(Date.now() / 1000);
  if (st.lastLocalBackup && now - st.lastLocalBackup < 24 * 60 * 60) return;
  const games = managedInstalledGames(new Set(await epicBackupExcluded()));
  if (games.length === 0) return;
  S.cloudBulkProgress = { done: 0, total: games.length, failed: 0, local: true };
  scheduleRender();
  let skipped = 0;
  let failed = 0;
  const failedTitles: string[] = [];
  for (const key of games) {
    try {
      const info = await epicBackupSaveIfChanged(key);
      if (!info) skipped += 1;
    } catch (error) {
      if (String(error).includes("backup.noSaveDir")) {
        skipped += 1;
      } else {
        failed += 1;
        failedTitles.push(cloudGameTitle(key));
      }
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  S.cloudBulkProgress = null;
  await updateCloudBackupSettings({ lastLocalBackup: now });
  scheduleRender();
  if (failed > 0) {
    console.warn(`scheduled local backup: ${failed} game(s) failed`);
  }
  notifyLocalBackupSummary(games.length, failed, failedTitles, "cloud.localBackupTitle", skipped);
}

export async function uploadGameCloudAction(appName: string, backupId?: string): Promise<void> {
  if (S.cloudBackupSyncing) return;
  S.cloudBackupSyncing = true;
  S.cloudBackupSyncingApp = appName;
  updateManageCloudRowInPlace(appName);
  toast(t("cloud.uploading"), "");
  try {
    const entry = await cloudBackupUploadGame(appName, backupId);
    const unchanged = !backupId && entry.timestamp < Math.floor(Date.now() / 1000) - 30;
    toast(t(unchanged ? "cloud.uploadUnchanged" : "cloud.uploadSuccess"), unchanged ? "" : "ok");
    notifyCloudUploadDone(appName, unchanged);
    const existing = S.cloudBackupsMap.get(appName) || [];
    S.cloudBackupsMap.set(appName, [entry, ...existing.filter((e) => e.backupId !== entry.backupId)]);
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
    notifyCloudUploadFailed(appName, String(err));
    updateManageCloudRowInPlace(appName);
  } finally {
    S.cloudBackupSyncing = false;
    S.cloudBackupSyncingApp = null;
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  }
}

export async function loadCloudBackupsAction(appName: string): Promise<CloudBackupEntry[]> {
  try {
    const list = await cloudBackupListGame(appName);
    S.cloudBackupsMap.set(appName, list);
    updateManageCloudRowInPlace(appName);
    return list;
  } catch {
    return [];
  }
}

export async function downloadCloudBackupAction(
  appName: string,
  remoteId: string,
  backupId: string,
): Promise<void> {
  // Restoring under a running game leaves locked files and a half-replaced
  // save tree. Ask the user to close it; the local snapshot is not a licence
  // to overwrite live files.
  if (S.runningGames.has(appName)) {
    toast(t("cloud.closeGameFirst"), "err");
    return;
  }
  const remote = (S.cloudBackupsMap.get(appName) || []).find((entry) => entry.remoteId === remoteId);
  const local = S.gameBackupsMap.get(appName)?.[0];
  if (remote && local && local.timestamp > remote.timestamp + 60) {
    // The timestamps differ, but the saves may still be byte-identical; only
    // ask when the content really changed. Older backups have no hash.
    let sameContent = false;
    if (local.content_hash) {
      try {
        sameContent =
          (await cloudBackupRemoteHash(remote.remoteId, remote.backupId)) === local.content_hash;
      } catch {
        sameContent = false;
      }
    }
    if (!sameContent) {
      const proceed = await askConfirm({
        title: t("cloud.conflictTitle"),
        body: t("cloud.conflictBody", {
          local: fmtCloudDate(local.timestamp),
          remote: fmtCloudDate(remote.timestamp),
        }),
        confirm: t("cloud.restoreAnyway"),
        cancel: t("common.cancel"),
      });
      if (!proceed) return;
    }
  }
  toast(t("cloud.downloading"), "");
  let preview;
  try {
    preview = await cloudBackupPreviewGame(appName, remoteId, backupId);
  } catch (err) {
    toast(String(err), "err");
    notifyCloudRestoreFailed(appName, String(err));
    return;
  }
  const restore = await askRestorePreview(preview);
  if (!restore) {
    void cloudBackupCancelRestore(preview.token).catch(() => undefined);
    return;
  }
  try {
    const msg = await cloudBackupApplyRestore(preview.token);
    toast(t("cloud.downloadSuccess"), "ok");
    notifyCloudRestoreDone(appName, msg);
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    void cloudBackupCancelRestore(preview.token).catch(() => undefined);
    toast(String(err), "err");
    notifyCloudRestoreFailed(appName, String(err));
  }
}

export async function deleteCloudBackupAction(appName: string, remoteId: string): Promise<void> {
  try {
    await cloudBackupDeleteRemote(remoteId);
    const existing = S.cloudBackupsMap.get(appName) || [];
    S.cloudBackupsMap.set(appName, existing.filter((e) => e.remoteId !== remoteId));
    toast(t("cloud.deleteSuccess"), "ok");
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
  }
}

export async function deleteAllCloudBackupsAction(appName: string): Promise<void> {
  const backups = [...(S.cloudBackupsMap.get(appName) || [])];
  if (backups.length === 0) return;
  toast(t("cloud.deletingAll"), "");
  try {
    for (const b of backups) {
      await cloudBackupDeleteRemote(b.remoteId);
    }
    S.cloudBackupsMap.set(appName, []);
    toast(t("cloud.deleteAllSuccess"), "ok");
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
    void loadCloudBackupsAction(appName);
  }
}


