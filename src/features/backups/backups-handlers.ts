/**
 * Actions for the Backups page. The page itself is plain HTML; everything that
 * touches disk (backup, export, restore, migration) starts here.
 */

import { askConfirm } from "../../core/confirm-dialog";
import { askPassword } from "../../core/password-dialog";
import { scheduleRender } from "../../core/render";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { fmtBytes } from "../../core/utils";
import { t as i18nT, localizeMessage } from "../../i18n";import { customGamesPickFile } from "../../custom-games";
import {
  cloudBackupExportMigration,
  cloudBackupImportMigration,
  epicBackupArchiveEncrypted,
  epicBackupSave,
  epicExportBackup,
  epicImportBackup,
  epicOpenFolderPath,
  epicPreviewBackup,
  epicRestoreBackup,
  epicSelectFolderDialog,
  epicSetCustomSavePath,
} from "../../epic";
import { askRestorePreview } from "../cloud-backup/restore-preview-dialog";
import { bulkLocalBackupAction } from "../cloud-backup/cloud-backup-actions";
import { collectProfileLocalStorage, finishProfileRestore } from "../cloud-backup/profile-sync-actions";
import { hydrateBackupsPage, storeLabel } from "./backups-page";

async function exportOne(key: string, backupId: string): Promise<void> {
  const folder = await epicSelectFolderDialog(null, i18nT("manage.exportPickFolder")).catch(() => null);
  if (!folder) return;
  const password = await askPassword({
    title: i18nT("manage.exportPasswordTitle"),
    body: i18nT("manage.exportPasswordBody"),
    placeholder: i18nT("profile.passwordPlaceholder"),
    confirm: i18nT("profile.export"),
    cancel: i18nT("common.cancel"),
  });
  if (password === null) return;
  const title = summaryOf(key)?.title || key;
  try {
    const path = await epicExportBackup(key, backupId, folder, title, password.trim() || undefined);
    toast(i18nT("manage.exported", { path }), "ok");
  } catch (error) {
    toast(i18nT("manage.exportFailed", { msg: localizeMessage(String(error)) }), "err");
  }
}

async function importOne(key: string): Promise<void> {
  const path = await customGamesPickFile(undefined, i18nT("manage.importPickFile")).catch(() => null);
  if (!path) return;
  let password: string | undefined;
  if (await epicBackupArchiveEncrypted(path).catch(() => false)) {
    const entered = await askPassword({
      title: i18nT("manage.importPasswordTitle"),
      body: i18nT("manage.importPasswordBody"),
      placeholder: i18nT("profile.passwordPlaceholder"),
      confirm: i18nT("manage.importSave"),
      cancel: i18nT("common.cancel"),
    });
    if (entered === null) return;
    if (!entered.trim()) {
      toast(i18nT("backup.passwordRequired"), "err");
      return;
    }
    password = entered;
  }
  try {
    const info = await epicImportBackup(key, path, password);
    toast(i18nT("manage.imported", { date: info.formatted_date }), "ok");
    void hydrateBackupsPage(true);
  } catch (error) {
    toast(i18nT("manage.importFailed", { msg: localizeMessage(String(error)) }), "err");
  }
}

async function exportEverything(): Promise<void> {
  const folder = await epicSelectFolderDialog(null, i18nT("backups.pickExportFolder")).catch(() => null);
  if (!folder) return;
  const password = await askPassword({
    title: i18nT("manage.exportPasswordTitle"),
    body: i18nT("manage.exportPasswordBody"),
    placeholder: i18nT("profile.passwordPlaceholder"),
    confirm: i18nT("backups.migrateExport"),
    cancel: i18nT("common.cancel"),
  });
  if (password === null) return;
  const titles: Record<string, string> = {};
  for (const key of S.allGamesMap.keys()) {
    const title = summaryOf(key)?.title;
    if (title) titles[key] = title;
  }
  try {
    const result = await cloudBackupExportMigration(
      folder,
      collectProfileLocalStorage(),
      password.trim() || undefined,
      titles,
    );
    toast(i18nT("backups.migrateExported", { games: result.games }), "ok");
    void epicOpenFolderPath(result.folder).catch(() => undefined);
  } catch (error) {
    toast(i18nT("backups.migrateFailed", { msg: localizeMessage(String(error)) }), "err");
  }
}

async function importEverything(): Promise<void> {
  const folder = await epicSelectFolderDialog(null, i18nT("backups.pickImportFolder")).catch(() => null);
  if (!folder) return;
  const proceed = await askConfirm({
    title: i18nT("backups.migrateImport"),
    body: i18nT("backups.migrateConfirm"),
    confirm: i18nT("backups.migrateImport"),
    cancel: i18nT("common.cancel"),
  });
  if (!proceed) return;
  const password = await askPassword({
    title: i18nT("manage.importPasswordTitle"),
    body: i18nT("manage.importPasswordBody"),
    placeholder: i18nT("profile.passwordPlaceholder"),
    confirm: i18nT("backups.migrateImport"),
    cancel: i18nT("common.cancel"),
  });
  if (password === null) return;
  try {
    const result = await cloudBackupImportMigration(folder, password.trim() || undefined);
    toast(i18nT("backups.migrateImported", { games: result.games }), "ok");
    await finishProfileRestore({
      filesRestored: 0,
      localStorage: result.localStorage,
      safetyArchive: "",
    });
  } catch (error) {
    toast(i18nT("backups.migrateFailed", { msg: localizeMessage(String(error)) }), "err");
  }
}

export function handleBackupsAction(act: string | undefined, t: HTMLElement, id?: string): boolean {
  switch (act) {
    case "backups-refresh":
      void hydrateBackupsPage(true);
      return true;

    case "backups-bulk":
      void bulkLocalBackupAction().then(() => hydrateBackupsPage(true));
      return true;

    case "backups-create":
      if (id) {
        void (async () => {
          try {
            const info = await epicBackupSave(id);
            toast(i18nT("backup.created", { size: fmtBytes(info.size_bytes), count: info.file_count }), "ok");
            void hydrateBackupsPage(true);
          } catch (error) {
            if (!String(error).includes("backup.noSaveDir")) {
              toast(i18nT("backup.failed", { msg: localizeMessage(String(error)) }), "err");
              return;
            }
            // No detected save folder: let the user point at it once.
            const chosen = await epicSelectFolderDialog(null, i18nT("manage.chooseSaveFolderTitle")).catch(() => null);
            if (!chosen) return;
            try {
              await epicSetCustomSavePath(id, chosen);
              const info = await epicBackupSave(id, chosen);
              toast(i18nT("backup.created", { size: fmtBytes(info.size_bytes), count: info.file_count }), "ok");
              void hydrateBackupsPage(true);
            } catch (inner) {
              toast(i18nT("backup.failed", { msg: localizeMessage(String(inner)) }), "err");
            }
          }
        })();
      }
      return true;

    case "backups-export": {
      const backupId = t.dataset.bid;
      if (id && backupId) void exportOne(id, backupId);
      return true;
    }

    case "backups-restore": {
      const backupId = t.dataset.bid;
      if (!id || !backupId) return true;
      if (S.runningGames.has(id)) {
        toast(i18nT("cloud.closeGameFirst"), "err");
        return true;
      }
      void (async () => {
        try {
          const preview = await epicPreviewBackup(id, backupId);
          if (preview.damaged) {
            toast(i18nT("backup.damaged"), "err");
            return;
          }
          if (!(await askRestorePreview(preview))) return;
          toast(i18nT("backup.restoring"), "");
          const message = await epicRestoreBackup(id, backupId, preview.currentHash ?? undefined);
          toast(message, "ok");
          void hydrateBackupsPage(true);
        } catch (error) {
          toast(
            i18nT("backup.restoreFailed", { msg: localizeMessage(String(error)) }),
            "err",
          );
        }
      })();
      return true;
    }

    case "backups-import":
      if (id) void importOne(id);
      return true;

    case "backups-export-all":
      void exportEverything();
      return true;

    case "backups-import-all":
      void importEverything();
      return true;

    default:
      return false;
  }
}

/** The page's per-game include switch writes the same setting the Manage drawer uses. */
export function updateBackupsIncluded(key: string, included: boolean): void {
  if (!S.backupsPage) return;
  if (included) S.backupsPage.excluded.delete(key);
  else S.backupsPage.excluded.add(key);
  scheduleRender();
}

/** A store label for a row that has no summary (imported leftovers). */
export function backupsStoreLabel(key: string): string {
  return storeLabel(key);
}
