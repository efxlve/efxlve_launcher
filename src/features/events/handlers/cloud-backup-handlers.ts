/**
 * Click delegation handlers for Cloud Save Backup (Google Drive & WebDAV).
 */

import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { esc } from "../../../core/utils";
import {
  bulkCloudBackupAction,
  bulkCloudRestoreAction,
  deleteAllCloudBackupsAction,
  deleteCloudBackupAction,
  disconnectGoogleDriveAction,
  downloadCloudBackupAction,
  loadCloudBackupsAction,
  runScheduledLocalBackupNow,
  scheduleLocalBackups,
  startGoogleDriveAuthAction,
  testCloudConnectionAction,
  updateCloudBackupSettings,
  uploadGameCloudAction,
} from "../../cloud-backup/cloud-backup-actions";
import {
  exportProfileAction,
  importProfileAction,
  restoreProfileFromCloudAction,
  runProfileUploadNow,
  scheduleProfileUploads,
  uploadProfileAction,
} from "../../cloud-backup/profile-sync-actions";
import {
  openGoogleDriveGuideModal,
  closeGoogleDriveGuideModal,
} from "../../cloud-backup/cloud-backup-view";
import type { CloudBackupProvider } from "../../../epic";
import { cloudBackupOpenFolder, cloudBackupRcloneRemotes, epicSelectFolderDialog } from "../../../epic";

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
        S.launcherProfileArchives = null;
        void updateCloudBackupSettings({ provider, enabled: true });
      }
      return true;
    }

    case "toggle-cloud-backup-enabled": {
      const chk = ((targetEl || t) as HTMLInputElement).checked ?? !S.cloudBackupSettings?.enabled;
      void updateCloudBackupSettings({
        enabled: chk,
        provider: chk && (!S.cloudBackupSettings || S.cloudBackupSettings.provider === "none") ? "folder" : S.cloudBackupSettings?.provider ?? "folder",
      });
      return true;
    }

    case "toggle-cloud-local-backup": {
      const chk = ((targetEl || t) as HTMLInputElement).checked;
      void updateCloudBackupSettings({ localBackupDaily: chk }).then((ok) => {
        if (ok && chk) {
          scheduleLocalBackups();
          runScheduledLocalBackupNow();
        }
      });
      return true;
    }

    case "toggle-cloud-auto-sync": {
      const chk = ((targetEl || t) as HTMLInputElement).checked ?? !S.cloudBackupSettings?.autoSyncOnGameExit;
      void updateCloudBackupSettings({ autoSyncOnGameExit: chk });
      return true;
    }

    case "open-gdrive-guide":
      openGoogleDriveGuideModal();
      return true;

    case "close-gdrive-guide":
      closeGoogleDriveGuideModal();
      return true;

    case "cloud-gdrive-save": {
      const clientIdInput = document.getElementById("cloud-gdrive-client-id") as HTMLInputElement | null;
      const clientSecretInput = document.getElementById("cloud-gdrive-client-secret") as HTMLInputElement | null;
      const gdriveClientId = clientIdInput?.value.trim() ?? "";
      const gdriveClientSecret = clientSecretInput?.value.trim() ?? "";
      void updateCloudBackupSettings({
        gdriveClientId,
        gdriveClientSecret,
      }).then((ok) => {
        if (ok) toast(i18nT("cloud.gdriveSaved"), "ok");
      });
      return true;
    }

    case "cloud-gdrive-connect": {
      const clientIdInput = document.getElementById("cloud-gdrive-client-id") as HTMLInputElement | null;
      const clientSecretInput = document.getElementById("cloud-gdrive-client-secret") as HTMLInputElement | null;
      const inputId = clientIdInput?.value.trim() ?? "";
      const inputSecret = clientSecretInput?.value.trim() ?? "";

      const currentId = inputId || (S.cloudBackupSettings?.gdriveClientId ?? "");
      const currentSecret = inputSecret || (S.cloudBackupSettings?.gdriveClientSecret ?? "");

      if (!currentId) {
        toast(i18nT("cloud.gdriveMissingClientId"), "err");
        openGoogleDriveGuideModal();
        return true;
      }

      void (async () => {
        if (inputId !== S.cloudBackupSettings?.gdriveClientId || inputSecret !== S.cloudBackupSettings?.gdriveClientSecret) {
          const saved = await updateCloudBackupSettings({
            gdriveClientId: currentId,
            gdriveClientSecret: currentSecret,
          });
          if (!saved) return;
        }
        await startGoogleDriveAuthAction();
      })();
      return true;
    }

    case "cloud-gdrive-disconnect":
      void disconnectGoogleDriveAction();
      return true;

    case "cloud-gdrive-test": {
      const clientIdInput = document.getElementById("cloud-gdrive-client-id") as HTMLInputElement | null;
      const clientSecretInput = document.getElementById("cloud-gdrive-client-secret") as HTMLInputElement | null;
      void (async () => {
        const saved = await updateCloudBackupSettings({
          gdriveClientId: clientIdInput?.value.trim() ?? "",
          gdriveClientSecret: clientSecretInput?.value.trim() ?? "",
        });
        if (!saved) return;
        await testCloudConnectionAction();
      })();
      return true;
    }

    case "cloud-folder-browse": {
      void (async () => {
        const current = S.cloudBackupSettings?.folderPath ?? "";
        const chosen = await epicSelectFolderDialog(current || null, i18nT("cloud.folderBrowse")).catch(() => null);
        if (!chosen) return;
        const ok = await updateCloudBackupSettings({ folderPath: chosen });
        if (ok) toast(i18nT("cloud.folderSaved"), "ok");
      })();
      return true;
    }

    case "cloud-bulk-backup": {
      void bulkCloudBackupAction();
      return true;
    }

    case "cloud-bulk-restore": {
      void bulkCloudRestoreAction();
      return true;
    }

    case "cloud-retention-save": {
      const input = document.getElementById("cloud-retention-count") as HTMLInputElement | null;
      const raw = Number(input?.value ?? 0);
      const count = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.floor(raw))) : 0;
      void updateCloudBackupSettings({ retentionCount: count }).then((ok) => {
        if (ok) toast(i18nT("cloud.retentionSaved"), "ok");
      });
      return true;
    }

    case "cloud-folder-open": {
      void cloudBackupOpenFolder()
        .then(() => toast(i18nT("win.folderOpened"), "ok"))
        .catch((err: unknown) => toast(String(err), "err"));
      return true;
    }

    case "cloud-folder-save": {
      const input = document.getElementById("cloud-folder-path") as HTMLInputElement | null;
      void updateCloudBackupSettings({ folderPath: input?.value.trim() ?? "" }).then((ok) => {
        if (ok) toast(i18nT("cloud.folderSaved"), "ok");
      });
      return true;
    }

    case "cloud-folder-test": {
      const input = document.getElementById("cloud-folder-path") as HTMLInputElement | null;
      void (async () => {
        const saved = await updateCloudBackupSettings({ folderPath: input?.value.trim() ?? "" });
        if (!saved) return;
        await testCloudConnectionAction();
      })();
      return true;
    }

    case "toggle-webdav-invalid-cert": {
      const checked = ((targetEl || t) as HTMLInputElement).checked;
      void updateCloudBackupSettings({ webdavAllowInvalidCert: checked });
      return true;
    }

    case "cloud-webdav-save": {
      const urlInput = document.getElementById("cloud-webdav-url") as HTMLInputElement | null;
      const userInput = document.getElementById("cloud-webdav-user") as HTMLInputElement | null;
      const passInput = document.getElementById("cloud-webdav-pass") as HTMLInputElement | null;
      void updateCloudBackupSettings({
        webdavUrl: urlInput?.value.trim() ?? "",
        webdavUsername: userInput?.value.trim() ?? "",
        webdavPassword: passInput?.value ?? "",
      }).then((ok) => {
        if (ok) toast(i18nT("cloud.webdavSaved"), "ok");
      });
      return true;
    }

    case "cloud-webdav-test": {
      const urlInput = document.getElementById("cloud-webdav-url") as HTMLInputElement | null;
      const userInput = document.getElementById("cloud-webdav-user") as HTMLInputElement | null;
      const passInput = document.getElementById("cloud-webdav-pass") as HTMLInputElement | null;
      void (async () => {
        const saved = await updateCloudBackupSettings({
          webdavUrl: urlInput?.value.trim() ?? "",
          webdavUsername: userInput?.value.trim() ?? "",
          webdavPassword: passInput?.value ?? "",
        });
        if (!saved) return;
        await testCloudConnectionAction();
      })();
      return true;
    }

    case "cloud-rclone-remotes": {
      void (async () => {
        try {
          const remotes = await cloudBackupRcloneRemotes();
          const box = document.getElementById("cloud-rclone-remotes");
          if (!box) return;
          box.innerHTML = remotes.length === 0
            ? `<span style="font-size:11px;color:var(--text-3)">${esc(i18nT("cloud.rcloneNone"))}</span>`
            : remotes
                .map(
                  (remote) =>
                    `<button type="button" class="btn ghost small" data-act="cloud-rclone-pick" data-remote="${esc(remote)}">${esc(remote)}</button>`,
                )
                .join("");
        } catch (err) {
          toast(String(err), "err");
        }
      })();
      return true;
    }

    case "cloud-rclone-pick": {
      const remote = t.dataset.remote ?? "";
      const input = document.getElementById("cloud-rclone-remote") as HTMLInputElement | null;
      if (input) input.value = `${remote}efxlve_saves`;
      return true;
    }

    case "profile-export":
      void exportProfileAction();
      return true;

    case "profile-import":
      void importProfileAction();
      return true;

    case "profile-cloud-upload":
      void uploadProfileAction();
      return true;

    case "toggle-profile-auto-upload": {
      const checked = ((targetEl || t) as HTMLInputElement).checked;
      void updateCloudBackupSettings({ profileDailyUpload: checked }).then((ok) => {
        if (ok && checked) {
          scheduleProfileUploads();
          runProfileUploadNow();
        }
      });
      return true;
    }

    case "profile-cloud-restore":
      void restoreProfileFromCloudAction();
      return true;

    case "cloud-rclone-save": {
      const input = document.getElementById("cloud-rclone-remote") as HTMLInputElement | null;
      void updateCloudBackupSettings({ rcloneRemote: input?.value.trim() ?? "" }).then((ok) => {
        if (ok) toast(i18nT("cloud.rcloneSaved"), "ok");
      });
      return true;
    }

    case "cloud-rclone-test": {
      const input = document.getElementById("cloud-rclone-remote") as HTMLInputElement | null;
      void (async () => {
        const saved = await updateCloudBackupSettings({ rcloneRemote: input?.value.trim() ?? "" });
        if (!saved) return;
        await testCloudConnectionAction();
      })();
      return true;
    }

    default:
      return false;
  }
}
