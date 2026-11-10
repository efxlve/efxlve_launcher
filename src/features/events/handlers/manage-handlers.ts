/**
 * Click delegation handlers for game management (verify, cloud saves, shortcuts,
 * custom save paths, local backups, playtime editor, move game across drives).
 */

import { progressToast, toast } from "../../../core/toast";
import { formatSyncStamp, localizeMessage, t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { esc, fmtBytes, parseEnvText } from "../../../core/utils";
import { rawOf, summaryOf } from "../../../core/selectors";
import { openEpicModal, scheduleRender } from "../../../core/render";
import { netMtuFix } from "../../../net-diag";
import { checkMtuAfterSyncFailure } from "../../manage/mtu-guard";
import { gogVerifyGame } from "../../../gog";
import { nileCreateDesktopShortcut, nileVerify } from "../../../nile";
import {
  closeManagePopup,
  manageSearchOpen,
  openManagePopup,
  resetVerifyInPlace,
  setManageSearchOpen,
  setManageTab,
  updateManageModalInputsInPlace,
  updateManageSyncBar,
  updateVerifyProgressInPlace,
} from "../../manage/manage-view";
import { rememberCloudSync, renderBackupListHtml } from "../../drawer/drawer-widgets";
import { repaintCloudWidget } from "../../drawer/drawer-view";
import {
  browseMoveTarget,
  cancelMoveGame,
  closeMoveGameModal,
  openMoveGameModal,
  startMoveGame,
} from "../../move-game/move-game-actions";
import { renderMoveGameModalFrame } from "../../move-game/move-game-view";
import {
  closeEditPlaytimeModal,
  openEditPlaytimeModal,
  saveEditedPlaytime,
} from "../../playtime/playtime-view";
import {
  epicBackupArchiveEncrypted,
  epicBackupSave,
  epicCreateDesktopShortcut,
  epicDeleteBackup,
  epicExportBackup,
  epicImportBackup,
  epicOpenBackupFolder,
  epicOpenFolderPath,
  epicPreviewBackup,
  epicRestoreBackup,
  epicSaveGameSettings,
  epicSelectFolderDialog,
  epicSetBackupLabel,
  epicSetCustomSavePath,
  epicSyncSaves,
  epicVerifyGame,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
} from "../../../epic";
import { askRestorePreview } from "../../cloud-backup/restore-preview-dialog";
import { askPassword } from "../../../core/password-dialog";
import { askText } from "../../../core/text-dialog";
import { customGamesPickFile } from "../../../custom-games";
import {
  notifyLocalBackupDone,
  notifyLocalBackupFailed,
  notifyLocalRestoreDone,
  notifyLocalRestoreFailed,
} from "../../cloud-backup/cloud-notify";
import { handleUpscalerAction } from "../../upscalers/upscaler-panel";

export function handleManageAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;
  if (act.startsWith("upscaler-")) {
    void handleUpscalerAction(act, t);
    return true;
  }

  switch (act) {
    case "manage-game":
      if (id) {
        // The panel is a layer over the page, not a seventh tab: leaving the
        // drawer on a tab that is not in the strip left the reader with nothing
        // highlighted and no way back. The same content also lives in the
        // System tab, so closing the panel never loses it.
        openManagePopup(id);
      }
      return true;

    case "close-manage-popup":
      closeManagePopup();
      return true;

    case "manage-search-toggle":
      setManageSearchOpen(!manageSearchOpen());
      return true;

    case "manage-tab":
      if (t.dataset.tab) setManageTab(t.dataset.tab);
      return true;

    case "manage-overlay-close":
      if (targetEl === t) closeManagePopup();
      return true;

    case "open-move-game-modal":
      if (id) {
        const raw = rawOf(id);
        const partner = getThirdPartyLauncher(raw);
        if (requiresThirdPartyLauncher(partner)) {
          toast(i18nT("manage.moveThirdPartyAlert", { name: partner!.name }), "");
          return true;
        }
        void openMoveGameModal(id);
      }
      return true;

    case "close-move-modal":
      closeMoveGameModal();
      return true;

    case "move-overlay-close":
      if (targetEl === t && !S.isMovingGame) closeMoveGameModal();
      return true;

    case "select-move-drive": {
      const drv = t.dataset.drive;
      if (drv && !S.isMovingGame) {
        S.selectedMoveDriveLetter = drv.toUpperCase();
        const curPath = S.selectedMoveTargetPath.replace(/^[a-zA-Z]:[\\/]/, "");
        S.selectedMoveTargetPath = `${S.selectedMoveDriveLetter}:\\${curPath || "Games"}`;
        renderMoveGameModalFrame();
      }
      return true;
    }

    case "browse-move-target":
      void browseMoveTarget();
      return true;

    case "start-move-game":
      if (id) void startMoveGame(id);
      return true;

    case "cancel-move-game":
      if (id) void cancelMoveGame(id);
      return true;

    case "manage-verify":
      if (id) {
        updateVerifyProgressInPlace(id, 0, 100, 0, i18nT("dl.starting"), i18nT("dl.starting"));
        if (id.startsWith("amazon::")) {
          // Hashing files while Nile is still downloading them would fight
          // over the same manifest and install record.
          if (S.downloads.has(id)) {
            resetVerifyInPlace(id);
            toast(i18nT("move.gameDownloading"), "err");
            return true;
          }
          nileVerify(id.slice(8)).catch((err) => {
            resetVerifyInPlace(id);
            toast(i18nT("manage.verifyStartFailed", { msg: String(err) }), "err");
          });
        } else if (id.startsWith("gog::")) {
          gogVerifyGame(id).catch((err) => {
            resetVerifyInPlace(id);
            toast(i18nT("manage.verifyStartFailed", { msg: String(err) }), "err");
          });
        } else {
          epicVerifyGame(id).catch((err) => {
            resetVerifyInPlace(id);
            toast(i18nT("manage.verifyStartFailed", { msg: String(err) }), "err");
          });
        }
      }
      return true;

    case "manage-sync-saves":
      if (id && (id.startsWith("gog::") || id.startsWith("steam::"))) return true;
      if (id && !S.manageSyncingSaves) {
        S.manageSyncingSaves = true;
        const syncBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-sync-saves"]');
        const cloudSub = document.getElementById("manage-cloud-subtitle");
        if (syncBtn) syncBtn.disabled = true;
        if (cloudSub) cloudSub.textContent = i18nT("manage.syncing");
        epicSyncSaves(id)
          .then((msg) => {
            toast(msg, "ok");
            const now = String(Date.now());
            rememberCloudSync(id, now);
            if (S.activeManageSettings && S.activeManageSettings.appName === id) {
              S.activeManageSettings.lastCloudSync = now;
            }
            if (cloudSub) cloudSub.textContent = i18nT("manage.lastSync", { time: formatSyncStamp(now) });
            repaintCloudWidget(id);
          })
          .catch((err) => {
            toast(i18nT("manage.syncFailed", { msg: localizeMessage(String(err)) }), "err");
            // A failed upload can be the path-MTU black hole; surface it once.
            void checkMtuAfterSyncFailure();
            if (cloudSub && S.activeManageSettings) {
              cloudSub.textContent = S.activeManageSettings.lastCloudSync
                ? i18nT("manage.lastSync", { time: formatSyncStamp(S.activeManageSettings.lastCloudSync) })
                : i18nT("manage.cloudDesc");
            }
          })
          .finally(() => {
            S.manageSyncingSaves = false;
            if (syncBtn) syncBtn.disabled = false;
            // A manual run emits progress but no completion event, so its entry
            // would keep the bar on "Syncing with cloud..." forever.
            S.cloudSyncProgress.delete(id);
            updateManageSyncBar(id);
          });
      }
      return true;

    case "fix-mtu": {
      const issue = S.mtuIssue;
      if (!issue) return true;
      netMtuFix(issue.interface, issue.suggestedMtu)
        .then(() => {
          S.mtuIssue = null;
          scheduleRender();
          toast(i18nT("manage.mtuFixed", { mtu: issue.suggestedMtu }), "ok");
        })
        .catch((err) => toast(i18nT("manage.mtuFixFailed", { msg: localizeMessage(String(err)) }), "err"));
      return true;
    }

    case "manage-create-shortcut":
      if (id) {
        const shortcut = id.startsWith("amazon::")
          ? nileCreateDesktopShortcut(id.slice(8))
          : epicCreateDesktopShortcut(id);
        shortcut
          .then((msg) => toast(msg, "ok"))
          .catch((err) => toast(i18nT("manage.shortcutFailed", { msg: String(err) }), "err"));
      }
      return true;

    case "manage-open-save-folder":
      if (id) {
        const activePath = S.activeManageSettings?.customSavePath || S.activeManageSettings?.savePath || S.activeManageSettings?.detectedSavePath;
        if (activePath) {
          epicOpenFolderPath(activePath).catch((err) => toast(i18nT("manage.folderOpenFailed", { a1: String(err) }), "err"));
        }
      }
      return true;

    case "manage-confirm-save-folder":
      if (id) {
        void (async () => {
          const detected =
            S.activeManageSettings?.detectedSavePath?.trim() ||
            S.activeManageSettings?.savePath?.trim() ||
            "";
          if (!detected) return;
          try {
            await epicSetCustomSavePath(id, detected);
            if (S.activeManageSettings && S.activeManageSettings.appName === id) {
              S.activeManageSettings.customSavePath = detected;
              updateManageModalInputsInPlace(S.activeManageSettings);
            }
            toast(i18nT("manage.saveFolderUpdated"), "ok");
          } catch (err) {
            toast(String(err), "err");
          }
        })();
      }
      return true;

    case "manage-choose-save-folder":
      if (id) {
        void (async () => {
          const current = S.activeManageSettings?.customSavePath || S.activeManageSettings?.savePath || S.activeManageSettings?.detectedSavePath || null;
          const chosen = await epicSelectFolderDialog(current, i18nT("manage.chooseSaveFolderTitle")).catch(() => null);
          if (!chosen) return;
          try {
            await epicSetCustomSavePath(id, chosen);
            if (S.activeManageSettings && S.activeManageSettings.appName === id) {
              S.activeManageSettings.customSavePath = chosen;
              updateManageModalInputsInPlace(S.activeManageSettings);
            }
            toast(i18nT("manage.saveFolderUpdated"), "ok");
          } catch (err) {
            toast(String(err), "err");
          }
        })();
      }
      return true;

    case "manage-reset-save-folder":
      if (id) {
        void (async () => {
          try {
            await epicSetCustomSavePath(id, null);
            if (S.activeManageSettings && S.activeManageSettings.appName === id) {
              S.activeManageSettings.customSavePath = null;
              updateManageModalInputsInPlace(S.activeManageSettings);
            }
            toast(i18nT("manage.saveFolderReset"), "ok");
          } catch (err) {
            toast(String(err), "err");
          }
        })();
      }
      return true;

    case "manage-create-backup":
      if (id && !S.isBackingUp) {
        S.isBackingUp = true;
        const createBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
        if (createBtn) { createBtn.disabled = true; createBtn.textContent = i18nT("backup.backingUp"); }
        toast(i18nT("backup.backingUp"), "");
        epicBackupSave(id)
          .then((b) => {
            toast(i18nT("backup.created", { size: fmtBytes(b.size_bytes), count: b.file_count }), "ok");
            notifyLocalBackupDone(id);
            const cur = S.gameBackupsMap.get(id) || [];
            S.gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
            const listEl = document.getElementById("manage-backup-list");
            if (listEl) listEl.innerHTML = renderBackupListHtml(id);
          })
          .catch(async (err) => {
            const errStr = String(err);
            if (errStr.includes("backup.noSaveDir")) {
              toast(i18nT("backup.selectFolderPrompt"), "err");
              const current = S.activeManageSettings?.customSavePath || S.activeManageSettings?.savePath || S.activeManageSettings?.detectedSavePath || null;
              const chosen = await epicSelectFolderDialog(current, i18nT("manage.chooseSaveFolderTitle")).catch(() => null);
              if (chosen) {
                try {
                  await epicSetCustomSavePath(id, chosen);
                  if (S.activeManageSettings && S.activeManageSettings.appName === id) {
                    S.activeManageSettings.customSavePath = chosen;
                    updateManageModalInputsInPlace(S.activeManageSettings);
                  }
                  const b = await epicBackupSave(id, chosen);
                  toast(i18nT("backup.created", { size: fmtBytes(b.size_bytes), count: b.file_count }), "ok");
                  notifyLocalBackupDone(id);
                  const cur = S.gameBackupsMap.get(id) || [];
                  S.gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
                  const listEl = document.getElementById("manage-backup-list");
                  if (listEl) listEl.innerHTML = renderBackupListHtml(id);
                } catch (innerErr) {
                  toast(i18nT("backup.failed", { msg: localizeMessage(String(innerErr)) }), "err");
                  notifyLocalBackupFailed(id, String(innerErr));
                }
              }
            } else {
              toast(i18nT("backup.failed", { msg: localizeMessage(errStr) }), "err");
              notifyLocalBackupFailed(id, errStr);
            }
          })
          .finally(() => {
            S.isBackingUp = false;
            const btnAfter = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
            if (btnAfter) { btnAfter.disabled = false; btnAfter.textContent = i18nT("manage.backup"); }
          });
      }
      return true;

    case "manage-export-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          void (async () => {
            const folder = await epicSelectFolderDialog(null, i18nT("manage.exportPickFolder")).catch(() => null);
            if (!folder) return;
            const password = await askPassword({
              title: i18nT("manage.exportPasswordTitle"),
              body: i18nT("manage.exportPasswordBody"),
              placeholder: i18nT("profile.passwordPlaceholder"),
              confirm: i18nT("profile.export"),
              cancel: i18nT("common.cancel"),
              confirmPlaceholder: i18nT("profile.passwordConfirmPlaceholder"),
              mismatch: i18nT("profile.passwordMismatch"),
            });
            if (password === null) return;
            const title = summaryOf(id)?.title || S.activeManageSettings?.title || id;
            try {
              const path = await epicExportBackup(
                id,
                bid,
                folder,
                title,
                password.trim() || undefined,
              );
              toast(i18nT("manage.exported", { path }), "ok");
              void epicOpenFolderPath(folder).catch(() => undefined);
            } catch (err) {
              toast(i18nT("manage.exportFailed", { msg: localizeMessage(String(err)) }), "err");
            }
          })();
        }
      }
      return true;

    case "manage-import-backup":
      if (id) {
        void (async () => {
          const path = await customGamesPickFile(undefined, i18nT("manage.importPickFile")).catch(() => null);
          if (!path) return;
          let password: string | undefined;
          const encrypted = await epicBackupArchiveEncrypted(path).catch(() => false);
          if (encrypted) {
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
            const b = await epicImportBackup(
              id,
              path,
              password,
              summaryOf(id)?.title || S.activeManageSettings?.title,
            );
            toast(i18nT("manage.imported", { date: b.formatted_date }), "ok");
            const cur = S.gameBackupsMap.get(id) || [];
            const next = [b, ...cur.filter((x) => x.id !== b.id)].sort(
              (a, z) => z.timestamp - a.timestamp,
            );
            S.gameBackupsMap.set(id, next);
            const listEl = document.getElementById("manage-backup-list");
            if (listEl) listEl.innerHTML = renderBackupListHtml(id);
          } catch (err) {
            toast(i18nT("manage.importFailed", { msg: localizeMessage(String(err)) }), "err");
          }
        })();
      }
      return true;

    case "manage-save-retention":
      if (id && S.activeManageSettings) {
        const input = document.getElementById("manage-backup-retention") as HTMLInputElement | null;
        const raw = Number(input?.value ?? 0);
        S.activeManageSettings.backupRetention = Number.isFinite(raw)
          ? Math.min(100, Math.max(0, Math.floor(raw)))
          : 0;
        epicSaveGameSettings(S.activeManageSettings)
          .then(() => toast(i18nT("manage.retentionSaved"), "ok"))
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "manage-restore-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          // Restoring under a running game leaves locked files and a
          // half-replaced save tree.
          if (S.runningGames.has(id)) {
            toast(i18nT("cloud.closeGameFirst"), "err");
            return true;
          }
          // A local restore used to start on a single click. Show the file
          // list and target folder first, then pass the previewed hash so a
          // session played in between refuses instead of being overwritten.
          // The preview also re-hashes the backup itself: a damaged copy is
          // stopped here, before it can overwrite a working save tree.
          void (async () => {
            const checking = progressToast(i18nT("backup.verifying"));
            try {
              const preview = await epicPreviewBackup(id, bid);
              checking.close();
              if (preview.damaged) {
                toast(i18nT("backup.damaged"), "err");
                notifyLocalRestoreFailed(id, i18nT("backup.damaged"));
                return;
              }
              if (!(await askRestorePreview(preview))) return;
              toast(i18nT("backup.restoring"), "");
              const msg = await epicRestoreBackup(id, bid, preview.currentHash ?? undefined);
              toast(msg, "ok");
              notifyLocalRestoreDone(id, msg);
            } catch (err) {
              checking.close();
              toast(
                i18nT("backup.restoreFailed", { msg: localizeMessage(String(err)) }),
                "err",
              );
              notifyLocalRestoreFailed(id, String(err));
            }
          })();
        }
      }
      return true;

    case "manage-label-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          const current = (S.gameBackupsMap.get(id) || []).find((x) => x.id === bid);
          void (async () => {
            const label = await askText({
              title: i18nT("manage.backupLabelTitle"),
              body: i18nT("manage.backupLabelBody"),
              placeholder: i18nT("manage.backupLabelPlaceholder"),
              value: current?.label ?? "",
              confirm: i18nT("common.save"),
              cancel: i18nT("common.cancel"),
            });
            if (label === null) return;
            try {
              const info = await epicSetBackupLabel(id, bid, label || null, current?.pinned ?? false);
              const cur = S.gameBackupsMap.get(id) || [];
              S.gameBackupsMap.set(
                id,
                cur.map((x) => (x.id === bid ? { ...x, ...info } : x)),
              );
              const listEl = document.getElementById("manage-backup-list");
              if (listEl) listEl.innerHTML = renderBackupListHtml(id);
              toast(i18nT("manage.backupLabelSaved"), "ok");
            } catch (err) {
              toast(i18nT("manage.backupLabelFailed", { msg: localizeMessage(String(err)) }), "err");
            }
          })();
        }
      }
      return true;

    case "manage-pin-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          const current = (S.gameBackupsMap.get(id) || []).find((x) => x.id === bid);
          if (current) {
            const next = !current.pinned;
            epicSetBackupLabel(id, bid, current.label ?? null, next)
              .then((info) => {
                const cur = S.gameBackupsMap.get(id) || [];
                S.gameBackupsMap.set(
                  id,
                  cur.map((x) => (x.id === bid ? { ...x, ...info } : x)),
                );
                const listEl = document.getElementById("manage-backup-list");
                if (listEl) listEl.innerHTML = renderBackupListHtml(id);
                toast(i18nT(next ? "manage.backupPinned" : "manage.backupUnpinned"), "ok");
              })
              .catch((err) =>
                toast(i18nT("manage.backupLabelFailed", { msg: localizeMessage(String(err)) }), "err"),
              );
          }
        }
      }
      return true;

    case "manage-delete-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          epicDeleteBackup(id, bid)
            .then(() => {
              toast(i18nT("backup.deleted"), "");
              const cur = S.gameBackupsMap.get(id) || [];
              S.gameBackupsMap.set(id, cur.filter((x) => x.id !== bid));
              const listEl = document.getElementById("manage-backup-list");
              if (listEl) listEl.innerHTML = renderBackupListHtml(id);
            })
            .catch((err) => toast(i18nT("backup.deleteFailed", { msg: localizeMessage(String(err)) }), "err"));
        }
      }
      return true;

    case "manage-open-backup-folder":
      if (id) {
        epicOpenBackupFolder(id)
          .then((msg) => toast(msg, "ok"))
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "manage-save-args":
      if (id && S.activeManageSettings) {
        const input = document.getElementById("manage-args-input") as HTMLInputElement | null;
        const val = input?.value?.trim() ?? "";
        S.activeManageSettings.launchParameters = val;
        epicSaveGameSettings(S.activeManageSettings)
          .then(() => toast(i18nT("manage.argsSaved"), "ok"))
          .catch((err) => toast(i18nT("manage.argsSaveFailed", { msg: String(err) }), "err"));
      }
      return true;

    case "manage-save-launch-extras":
      if (id && S.activeManageSettings) {
        const wrapperEl = document.getElementById("manage-wrapper-input") as HTMLInputElement | null;
        const envEl = document.getElementById("manage-env-input") as HTMLTextAreaElement | null;
        S.activeManageSettings.wrapper = wrapperEl?.value?.trim() ?? "";
        S.activeManageSettings.envVars = parseEnvText(envEl?.value ?? "");
        epicSaveGameSettings(S.activeManageSettings)
          .then(() => toast(i18nT("manage.launchExtrasSaved"), "ok"))
          .catch((err) => toast(i18nT("manage.argsSaveFailed", { msg: String(err) }), "err"));
      }
      return true;

    case "open-edit-playtime":
      if (id) openEditPlaytimeModal(id);
      return true;

    case "close-edit-playtime":
      closeEditPlaytimeModal();
      return true;

    case "playtime-overlay-close":
      if (targetEl === t) closeEditPlaytimeModal();
      return true;

    case "pt-quick-add": {
      const addHours = parseInt(t.dataset.hours || "0", 10);
      const input = document.getElementById("pt-hours-input") as HTMLInputElement | null;
      if (input) {
        const cur = parseInt(input.value || "0", 10) || 0;
        input.value = String(Math.max(0, cur + addHours));
      }
      const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
      if (lpSelect && !lpSelect.value) {
        lpSelect.value = "Daha önce oynandı (Epic Games)";
      }
      return true;
    }

    case "pt-reset": {
      const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
      const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
      const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
      if (hInput) hInput.value = "0";
      if (mInput) mInput.value = "0";
      if (lpSelect) lpSelect.value = "";
      return true;
    }

    case "save-playtime":
      if (id) void saveEditedPlaytime(id);
      return true;

    default:
      return false;
  }
}
