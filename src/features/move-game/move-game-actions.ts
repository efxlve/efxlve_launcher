/**
 * Cross-drive game move: modal orchestration and the move/cancel actions.
 *
 * Pure view helpers live in move-game-view.ts; this file handles disk
 * enumeration, starting the transfer and updating shared state.
 */

import { moveModalRoot } from "../../core/dom";
import { refreshEpicInstalled } from "../../core/epic-actions";
import { epicDlProgress } from "../../core/game-view";
import { openEpicModal } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";

import {
  epicCancelMoveGame,
  epicGetGameSettings,
  epicGetSystemDrives,
  epicMoveGame,
  epicSelectFolderDialog,
} from "../../epic";
import { updateManageModalInputsInPlace } from "../manage/manage-view";
import { renderMoveGameModalFrame } from "./move-game-view";
export function applyMovedGamePath(appName: string, newPath: string): void {
  if (!appName || !newPath) return;

  // 1. Update the game's installPath in the epicSummaries list immediately.
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (s) {
    s.installPath = newPath;
  }

  // 2. If the manage panel is open, update the path there too.
  if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
    S.activeManageSettings.installPath = newPath;
  }

  // 3. Update every visible "install location" DOM text instantly (0ms).
  const pathEls = document.querySelectorAll("#manage-install-path");
  pathEls.forEach((el) => {
    el.textContent = newPath;
  });

  // 4. Keep the manage panel inputs in sync in place.
  if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
    updateManageModalInputsInPlace(S.activeManageSettings);
  }
}

export function closeMoveGameModal(): void {
  if (S.isMovingGame) {
    toast(t("move.inProgress"), "");
    return;
  }
  S.activeMoveModalAppName = null;
  S.activeMoveProgress = null;
  const root = moveModalRoot || document.getElementById("move-modal-root");
  if (root) root.innerHTML = "";
}


export async function openMoveGameModal(appName: string): Promise<void> {
  if (S.isMovingGame) {
    toast(t("move.busy"), "");
    return;
  }
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s || !s.installed) {
    toast(t("move.notInstalled"), "err");
    return;
  }

  S.activeMoveModalAppName = appName;
  S.activeMoveProgress = null;

  try {
    S.moveSystemDrives = await epicGetSystemDrives();
  } catch (err) {
    console.warn("System drives could not be detected:", err);
    S.moveSystemDrives = [];
  }

  const curPath = s.installPath || "";
  const curDrive = curPath.length >= 2 && curPath[1] === ":" ? curPath[0].toUpperCase() : "";
  const installSize = s.installSize || 0;

  // Default target drive: the first other drive with enough free space.
  const otherDriveWithSpace = S.moveSystemDrives.find(
    (d) => d.letter.toUpperCase() !== curDrive && d.available_bytes >= installSize
  );
  const anyOtherDrive = S.moveSystemDrives.find((d) => d.letter.toUpperCase() !== curDrive);

  if (otherDriveWithSpace) {
    S.selectedMoveDriveLetter = otherDriveWithSpace.letter.toUpperCase();
  } else if (anyOtherDrive) {
    S.selectedMoveDriveLetter = anyOtherDrive.letter.toUpperCase();
  } else if (curDrive) {
    S.selectedMoveDriveLetter = curDrive;
  } else if (S.moveSystemDrives.length > 0) {
    S.selectedMoveDriveLetter = S.moveSystemDrives[0].letter.toUpperCase();
  } else {
    S.selectedMoveDriveLetter = "D";
  }

  // Default target folder: \Games on the selected drive.
  S.selectedMoveTargetPath = `${S.selectedMoveDriveLetter}:\\Games`;

  renderMoveGameModalFrame();
}

export async function browseMoveTarget(): Promise<void> {
  if (S.isMovingGame) return;
  const defaultDir =
    S.selectedMoveTargetPath ||
    (S.selectedMoveDriveLetter ? `${S.selectedMoveDriveLetter}:\\` : null);
  try {
    const chosen = await epicSelectFolderDialog(defaultDir);
    if (chosen) {
      S.selectedMoveTargetPath = chosen;
      if (chosen.length >= 2 && chosen[1] === ":") {
        S.selectedMoveDriveLetter = chosen[0].toUpperCase();
      }
      renderMoveGameModalFrame();
    }
  } catch (err) {
    toast(`Klasör seçim hatası: ${String(err)}`, "err");
  }
}

export async function startMoveGame(appName: string): Promise<void> {
  if (S.isMovingGame) return;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s) return;

  if (S.runningGames.has(appName)) {
    toast("Oyun şu anda açık/çalışıyor! Lütfen önce oyunu kapatın.", "err");
    return;
  }
  if (epicDlProgress(appName) !== null) {
    toast("Oyun şu anda indiriliyor veya güncelleniyor! Lütfen bitmesini bekleyin.", "err");
    return;
  }

  const target = S.selectedMoveTargetPath.trim();
  if (!target) {
    toast("Lütfen geçerli bir hedef klasör belirtin!", "");
    return;
  }

  S.isMovingGame = true;
  S.activeMoveProgress = {
    id: appName,
    stage: "preparing",
    percent: 0,
    copied_bytes: 0,
    total_bytes: s.installSize || 0,
    speed: t("dl.starting"),
    eta: t("common.calculating"),
    current_file: "",
    files_copied: 0,
    total_files: 0,
  };
  renderMoveGameModalFrame();

  try {
    const res = await epicMoveGame(appName, target);
    if (res.success) {
      const newPath = res.new_path || (res as any).newPath || "";
      if (newPath) {
        applyMovedGamePath(appName, newPath);
      }
      toast(res.message || t("move.success"), "ok");
      S.isMovingGame = false;
      closeMoveGameModal();

      // Refresh the installed-games list from disk.
      await refreshEpicInstalled();

      // Fetch fresh settings in the background and keep state in sync.
      try {
        const freshSettings = await epicGetGameSettings(appName);
        if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
          S.activeManageSettings = freshSettings;
          updateManageModalInputsInPlace(freshSettings);
        }
      } catch {}

      // Re-apply the moved path in case refreshEpicInstalled replaced the summary.
      if (newPath) {
        applyMovedGamePath(appName, newPath);
      }

      // If the game detail drawer is open, repaint it smoothly.
      if (S.currentModalAppName === appName) {
        openEpicModal(appName, false);
      }
    } else {
      toast(t("move.failed", { msg: res.message }), "err");
      S.isMovingGame = false;
      renderMoveGameModalFrame();
    }
  } catch (err) {
    toast(t("move.error", { msg: String(err) }), "err");
    S.isMovingGame = false;
    renderMoveGameModalFrame();
  }
}

export async function cancelMoveGame(appName: string): Promise<void> {
  try {
    await epicCancelMoveGame(appName);
    toast(t("move.cancelling"), "");
  } catch (err) {
    toast(t("move.cancelFailed", { msg: String(err) }), "err");
  }
}

/* ---------- Epic download ---------- */


