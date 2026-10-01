/**
 * Click delegation handlers for Cloud Save Backup (Google Drive & WebDAV).
 */

import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import {
  deleteAllCloudBackupsAction,
  deleteCloudBackupAction,
  disconnectGoogleDriveAction,
  downloadCloudBackupAction,
  loadCloudBackupsAction,
  startGoogleDriveAuthAction,
  testCloudConnectionAction,
  updateCloudBackupSettings,
  uploadGameCloudAction,
} from "../../cloud-backup/cloud-backup-actions";
import type { CloudBackupProvider } from "../../../epic";

export function handleCloudBackupAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "manage-cloud-upload":
      if (id) void uploadGameCloudAction(id);
      return true;

    case "manage-cloud-sync":
      if (id) {
        void (async () => {
          toast(i18nT("cloud.syncTooltip"), "");
          await loadCloudBackupsAction(id);
          await uploadGameCloudAction(id);
        })();
      }
      return true;

    case "manage-cloud-restore": {
      const btn = t.closest<HTMLElement>('[data-act="manage-cloud-restore"]') ?? t;
      const remoteId = btn.dataset.remoteId;
      const backupId = btn.dataset.bid;
      if (id && remoteId && backupId) {
        void downloadCloudBackupAction(id, remoteId, backupId);
      } else {
        const latest = id ? S.cloudBackupsMap.get(id)?.[0] : undefined;
        if (id && latest) void downloadCloudBackupAction(id, latest.remoteId, latest.backupId);
      }
      return true;
    }

    case "manage-cloud-delete": {
      const btn = t.closest<HTMLElement>('[data-act="manage-cloud-delete"]') ?? t;
      const remoteId = btn.dataset.remoteId;
      if (id && remoteId) {
        void deleteCloudBackupAction(id, remoteId);
      } else {
        const latest = id ? S.cloudBackupsMap.get(id)?.[0] : undefined;
        if (id && latest) void deleteCloudBackupAction(id, latest.remoteId);
      }
      return true;
    }

    case "manage-cloud-delete-all": {
      if (id) void deleteAllCloudBackupsAction(id);
      return true;
    }

    case "set-cloud-provider": {
      const provider = t.dataset.provider as CloudBackupProvider;
      if (provider) {
        void updateCloudBackupSettings({ provider, enabled: true });
      }
      return true;
    }

    case "toggle-cloud-backup-enabled": {
      const chk = ((targetEl || t) as HTMLInputElement).checked ?? !S.cloudBackupSettings?.enabled;
      void updateCloudBackupSettings({
        enabled: chk,
        provider: chk && (!S.cloudBackupSettings || S.cloudBackupSettings.provider === "none") ? "google_drive" : S.cloudBackupSettings?.provider ?? "google_drive",
      });
      return true;
    }

    case "toggle-cloud-auto-sync": {
      const chk = ((targetEl || t) as HTMLInputElement).checked ?? !S.cloudBackupSettings?.autoSyncOnGameExit;
      void updateCloudBackupSettings({ autoSyncOnGameExit: chk });
      return true;
    }

    case "cloud-gdrive-connect":
      void startGoogleDriveAuthAction();
      return true;

    case "cloud-gdrive-disconnect":
      void disconnectGoogleDriveAction();
      return true;

    case "cloud-webdav-save": {
      const urlInput = document.getElementById("cloud-webdav-url") as HTMLInputElement | null;
      const userInput = document.getElementById("cloud-webdav-user") as HTMLInputElement | null;
      const passInput = document.getElementById("cloud-webdav-pass") as HTMLInputElement | null;
      void updateCloudBackupSettings({
        webdavUrl: urlInput?.value.trim() ?? "",
        webdavUsername: userInput?.value.trim() ?? "",
        webdavPassword: passInput?.value ?? "",
      }).then(() => toast(i18nT("cloud.webdavSaved"), "ok"));
      return true;
    }

    case "cloud-webdav-test": {
      const urlInput = document.getElementById("cloud-webdav-url") as HTMLInputElement | null;
      const userInput = document.getElementById("cloud-webdav-user") as HTMLInputElement | null;
      const passInput = document.getElementById("cloud-webdav-pass") as HTMLInputElement | null;
      void (async () => {
        await updateCloudBackupSettings({
          webdavUrl: urlInput?.value.trim() ?? "",
          webdavUsername: userInput?.value.trim() ?? "",
          webdavPassword: passInput?.value ?? "",
        });
        await testCloudConnectionAction();
      })();
      return true;
    }

    default:
      return false;
  }
}
