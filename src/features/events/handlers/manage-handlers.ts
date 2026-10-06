/**
 * Click delegation handlers for game management (verify, cloud saves, shortcuts,
 * custom save paths, local backups, playtime editor, move game across drives).
 */

import { toast } from "../../../core/toast";
import { formatSyncStamp, localizeMessage, t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { esc, fmtBytes, parseEnvText } from "../../../core/utils";
import { rawOf } from "../../../core/selectors";
import { openEpicModal } from "../../../core/render";
import { gogVerifyGame } from "../../../gog";
import { nileCreateDesktopShortcut, nileVerify } from "../../../nile";
import {
  closeManagePopup,
  openManagePopup,
  resetVerifyInPlace,
  updateManageModalInputsInPlace,
  updateVerifyProgressInPlace,
} from "../../manage/manage-view";
import { rememberCloudSync, renderBackupListHtml } from "../../drawer/drawer-widgets";
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
  epicBackupSave,
  epicCreateDesktopShortcut,
  epicDeleteBackup,
  epicOpenBackupFolder,
  epicOpenFolderPath,
  epicRestoreBackup,
  epicSaveGameSettings,
  epicSelectFolderDialog,
  epicSetCustomSavePath,
  epicSyncSaves,
  epicVerifyGame,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
} from "../../../epic";

export function handleManageAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "manage-game":
      if (id) {
        if (S.activeDrawerTab === "manage") {
          S.activeDrawerTab = "overview";
          if (S.currentModalAppName === id) openEpicModal(id, false);
        }
        openManagePopup(id);
      }
      return true;

    case "close-manage-popup":
      closeManagePopup();
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
            const cloudVal = document.getElementById("gp-stat-cloud-val");
            if (cloudVal && S.currentModalAppName === id) {
              cloudVal.textContent = i18nT("drawer.cloudSynced");
              cloudVal.classList.add("ok");
              cloudVal.classList.remove("warn");
              const wrap = cloudVal.closest(".gp-stat");
              if (wrap) wrap.setAttribute("title", i18nT("manage.lastSync", { time: now }));
            }
          })
          .catch((err) => {
            toast(i18nT("manage.syncFailed", { msg: localizeMessage(String(err)) }), "err");
            if (cloudSub && S.activeManageSettings) {
              cloudSub.textContent = S.activeManageSettings.lastCloudSync
                ? i18nT("manage.lastSync", { time: formatSyncStamp(S.activeManageSettings.lastCloudSync) })
                : i18nT("manage.cloudDesc");
            }
          })
          .finally(() => {
            S.manageSyncingSaves = false;
            if (syncBtn) syncBtn.disabled = false;
          });
      }
      return true;

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
                  const cur = S.gameBackupsMap.get(id) || [];
                  S.gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
                  const listEl = document.getElementById("manage-backup-list");
                  if (listEl) listEl.innerHTML = renderBackupListHtml(id);
                } catch (innerErr) {
                  toast(i18nT("backup.failed", { msg: localizeMessage(String(innerErr)) }), "err");
                }
              }
            } else {
              toast(i18nT("backup.failed", { msg: localizeMessage(errStr) }), "err");
            }
          })
          .finally(() => {
            S.isBackingUp = false;
            const btnAfter = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
            if (btnAfter) { btnAfter.disabled = false; btnAfter.textContent = i18nT("manage.backup"); }
          });
      }
      return true;

    case "manage-restore-backup":
      if (id) {
        const bid = t.dataset.bid;
        if (bid) {
          toast(i18nT("backup.restoring"), "");
          epicRestoreBackup(id, bid)
            .then((msg) => toast(msg, "ok"))
            .catch((err) => toast(i18nT("backup.restoreFailed", { msg: localizeMessage(String(err)) }), "err"));
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
