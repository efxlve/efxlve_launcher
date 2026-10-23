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
import {
  cloudBackupGetSettings,
  cloudBackupSaveSettings,
  cloudBackupTestConnection,
  cloudBackupStartGdriveAuth,
  cloudBackupDisconnectGdrive,
  cloudBackupUploadGame,
  cloudBackupListGame,
  cloudBackupDownloadGame,
  cloudBackupDeleteRemote,
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

export async function updateCloudBackupSettings(
  patch: Partial<CloudBackupSettings>,
): Promise<boolean> {
  const current = S.cloudBackupSettings ?? {
    enabled: false,
    provider: "none",
    autoSyncOnGameExit: false,
    retentionCount: 0,
    folderPath: "",
    webdavUrl: "",
    webdavUsername: "",
    webdavPassword: "",
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
function managedInstalledGames(): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of S.allGamesMap.values()) {
    if (!item.installed) continue;
    if (!["epic", "gog", "amazon", "custom"].includes(item.source)) continue;
    const key = item.source === "epic" ? item.id : item.key;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Backs up every installed game from the stores the launcher manages. */
export async function bulkCloudBackupAction(): Promise<void> {
  if (S.cloudBulkProgress) return;
  const games = managedInstalledGames();
  if (games.length === 0) {
    toast(t("cloud.bulkNone"), "");
    return;
  }
  S.cloudBulkProgress = { done: 0, total: games.length, failed: 0 };
  scheduleRender();
  let failed = 0;
  for (const key of games) {
    try {
      await cloudBackupUploadGame(key);
    } catch {
      failed += 1;
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  const total = games.length;
  S.cloudBulkProgress = null;
  scheduleRender();
  toast(t("cloud.bulkDone", { total, failed }), failed > 0 ? "err" : "ok");
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
  for (const key of games) {
    try {
      const backups = await cloudBackupListGame(key);
      const latest = backups?.[0];
      if (latest) {
        await cloudBackupDownloadGame(key, latest.remoteId, latest.backupId);
        restored += 1;
      }
    } catch {
      failed += 1;
    }
    S.cloudBulkProgress.done += 1;
    S.cloudBulkProgress.failed = failed;
    scheduleRender();
  }
  S.cloudBulkProgress = null;
  scheduleRender();
  toast(t("cloud.bulkRestoreDone", { total: restored, failed }), failed > 0 ? "err" : "ok");
}

export async function uploadGameCloudAction(appName: string, backupId?: string): Promise<void> {
  if (S.cloudBackupSyncing) return;
  S.cloudBackupSyncing = true;
  S.cloudBackupSyncingApp = appName;
  updateManageCloudRowInPlace(appName);
  toast(t("cloud.uploading"), "");
  try {
    const entry = await cloudBackupUploadGame(appName, backupId);
    toast(t("cloud.uploadSuccess"), "ok");
    const existing = S.cloudBackupsMap.get(appName) || [];
    S.cloudBackupsMap.set(appName, [entry, ...existing.filter((e) => e.backupId !== entry.backupId)]);
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
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
  const remote = (S.cloudBackupsMap.get(appName) || []).find((entry) => entry.remoteId === remoteId);
  const local = S.gameBackupsMap.get(appName)?.[0];
  if (remote && local && local.timestamp > remote.timestamp + 60) {
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
  toast(t("cloud.downloading"), "");
  try {
    await cloudBackupDownloadGame(appName, remoteId, backupId);
    toast(t("cloud.downloadSuccess"), "ok");
    updateManageCloudRowInPlace(appName);
    scheduleRender();
  } catch (err) {
    toast(String(err), "err");
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


