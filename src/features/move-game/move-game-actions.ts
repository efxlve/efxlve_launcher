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
import { nileGameSettings, nileMoveGame } from "../../nile";
import { loadAmazonSession } from "../auth/amazon-auth-actions";
import { updateManageModalInputsInPlace } from "../manage/manage-view";
import { renderMoveGameModalFrame } from "./move-game-view";
import { sourceOfKey, summaryOf } from "../../core/selectors";
export function applyMovedGamePath(appName: string, newPath: string): void {
  if (!appName || !newPath) return;

  // 1. Update the game's installPath in the epicSummaries list immediately.
  const s = summaryOf(appName);
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
  S.moveBatchApps = [];
  S.moveBatchIndex = 0;
  const root = moveModalRoot || document.getElementById("move-modal-root");
  if (root) root.innerHTML = "";
}


export async function openMoveGameModal(appName: string): Promise<void> {
  S.moveBatchApps = [appName];
  S.moveBatchIndex = 0;
  await prepareMoveModal(appName);
}

/** Opens the same modal for a multi-game move; the target is chosen once. */
export async function openMoveGamesModal(appNames: string[]): Promise<void> {
  const unique = [...new Set(appNames)].filter((id) => {
    const sum = summaryOf(id);
    const source = sourceOfKey(id);
    return Boolean(sum?.installed) && (source === "epic" || source === "amazon");
  });
  if (unique.length === 0) {
    toast(t("move.noSelection"), "");
    return;
  }
  S.moveBatchApps = unique;
  S.moveBatchIndex = 0;
  await prepareMoveModal(unique[0]);
}

async function prepareMoveModal(appName: string): Promise<void> {
  if (S.isMovingGame) {
    toast(t("move.busy"), "");
    return;
  }
  const s = summaryOf(appName);
  if (!s || !s.installed) {
    toast(t("move.notInstalled"), "err");
    return;
  }

  S.activeMoveModalAppName = appName;
  S.activeMoveProgress = null;

  try {
    S.moveSystemDrives = (await epicGetSystemDrives()) ?? [];
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
    const chosen = await epicSelectFolderDialog(defaultDir, t("move.pickerTitle"));
    if (chosen) {
      S.selectedMoveTargetPath = chosen;
      if (chosen.length >= 2 && chosen[1] === ":") {
        S.selectedMoveDriveLetter = chosen[0].toUpperCase();
      }
      renderMoveGameModalFrame();
    }
  } catch (err) {
    toast(t("move.folderSelectFailed", { msg: String(err) }), "err");
  }
}

interface MoveOutcome {
  ok: boolean;
  message: string;
  newPath: string;
}

async function moveOneGame(appName: string, target: string): Promise<MoveOutcome> {
  const s = summaryOf(appName);
  if (!s) return { ok: false, message: t("move.notInstalled"), newPath: "" };
  if (S.runningGames.has(appName)) {
    return { ok: false, message: t("move.gameRunning"), newPath: "" };
  }
  if (epicDlProgress(appName) !== null) {
    return { ok: false, message: t("move.gameDownloading"), newPath: "" };
  }

  const isAmazon = appName.startsWith("amazon::");
  try {
    const res = isAmazon
      ? await nileMoveGame(appName, target)
      : await epicMoveGame(appName, target);
    if (!res.success) {
      return { ok: false, message: res.message || t("common.error"), newPath: "" };
    }
    const newPath = res.new_path || (res as { newPath?: string }).newPath || "";
    if (newPath) applyMovedGamePath(appName, newPath);
    return { ok: true, message: res.message || t("move.success"), newPath };
  } catch (err) {
    return { ok: false, message: t("move.error", { msg: String(err) }), newPath: "" };
  }
}

/**
 * Moves one game or the selected batch to the chosen folder. A batch keeps the
 * same modal open, updates the subject for each game, and refreshes the stores
 * once at the end instead of after every folder.
 */
export async function startMoveGame(appName: string): Promise<void> {
  if (S.isMovingGame) return;
  const target = S.selectedMoveTargetPath.trim();
  if (!target) {
    toast(t("move.invalidTarget"), "");
    return;
  }

  const batch = S.moveBatchApps.length > 0 ? [...S.moveBatchApps] : [appName];
  S.isMovingGame = true;
  const movedPaths: Array<[string, string]> = [];
  let moved = 0;
  let failure = "";
  let failedApp = "";

  for (let index = 0; index < batch.length; index++) {
    const id = batch[index];
    S.moveBatchIndex = index;
    S.activeMoveModalAppName = id;
    const sum = summaryOf(id);
    S.activeMoveProgress = {
      id,
      stage: "preparing",
      percent: 0,
      copied_bytes: 0,
      total_bytes: sum?.installSize || 0,
      speed: t("dl.starting"),
      eta: t("common.calculating"),
      current_file: "",
      files_copied: 0,
      total_files: 0,
    };
    renderMoveGameModalFrame();

    const outcome = await moveOneGame(id, target);
    if (!outcome.ok) {
      failedApp = id;
      failure = outcome.message;
      break;
    }
    if (outcome.newPath) movedPaths.push([id, outcome.newPath]);
    moved++;
  }

  S.isMovingGame = false;
  S.activeMoveProgress = null;

  if (failure) {
    // A retry should continue with the games that did not land, not repeat the
    // ones that already moved.
    S.moveBatchApps = batch.slice(moved);
    S.moveBatchIndex = 0;
    S.activeMoveModalAppName = failedApp || batch[moved] || batch[0];
    renderMoveGameModalFrame();
    const message = batch.length > 1
      ? t("move.batchFailed", { moved, count: batch.length, msg: failure })
      : failure;
    toast(message, "err");
    return;
  }

  const movedAmazon = batch.some((id) => id.startsWith("amazon::"));
  const movedEpic = batch.some((id) => !id.startsWith("amazon::"));
  closeMoveGameModal();
  const doneMessage = batch.length > 1
    ? t("move.batchDone", { count: moved })
    : movedPaths[0]
      ? t("move.successPath", { a1: movedPaths[0][1] })
      : t("move.success");
  toast(doneMessage, "ok");

  // Refresh the installed list once for the whole batch, then re-apply the new
  // paths in case the refresh rebuilt the summary objects.
  if (movedAmazon) await loadAmazonSession(false);
  if (movedEpic) await refreshEpicInstalled();
  for (const [id, newPath] of movedPaths) applyMovedGamePath(id, newPath);

  // Keep an open Manage panel and game page on the new location.
  const manageApp = S.activeManageSettings?.appName;
  if (manageApp && batch.includes(manageApp)) {
    try {
      const freshSettings = manageApp.startsWith("amazon::")
        ? await nileGameSettings(manageApp.slice(8))
        : await epicGetGameSettings(manageApp);
      if (S.activeManageSettings?.appName === manageApp) {
        S.activeManageSettings = freshSettings;
        updateManageModalInputsInPlace(freshSettings);
      }
    } catch {
      // The moved path is already applied; a settings refresh is best effort.
    }
  }
  if (S.currentModalAppName && batch.includes(S.currentModalAppName)) {
    openEpicModal(S.currentModalAppName, false);
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


