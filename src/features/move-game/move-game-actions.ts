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

  // 1. epicSummaries listesindeki oyunun installPath değerini hemen güncelle
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (s) {
    s.installPath = newPath;
  }

  // 2. Aktif yönetim ayarları açıksa (drawer veya modal) oradaki yolu güncelle
  if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
    S.activeManageSettings.installPath = newPath;
  }

  // 3. Ekranda açık olan tüm "Kurulum Konumu" DOM metinlerini anında (0ms) güncelle
  const pathEls = document.querySelectorAll("#manage-install-path");
  pathEls.forEach((el) => {
    el.textContent = newPath;
  });

  // 4. Quick manage modal açıksa inputları da yerinde senkronize et
  if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
    updateManageModalInputsInPlace(S.activeManageSettings);
  }
}

export function closeMoveGameModal(): void {
  if (S.isMovingGame) {
    toast("Taşıma işlemi devam ediyor, lütfen önce iptal edin!", "");
    return;
  }
  S.activeMoveModalAppName = null;
  S.activeMoveProgress = null;
  const root = moveModalRoot || document.getElementById("move-modal-root");
  if (root) root.innerHTML = "";
}


export async function openMoveGameModal(appName: string): Promise<void> {
  if (S.isMovingGame) {
    toast("Başka bir taşıma işlemi devam ediyor!", "");
    return;
  }
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s || !s.installed) {
    toast("Bu oyun kurulu değil veya bulunamadı!", "err");
    return;
  }

  S.activeMoveModalAppName = appName;
  S.activeMoveProgress = null;

  try {
    S.moveSystemDrives = await epicGetSystemDrives();
  } catch (err) {
    console.warn("Sürücüler tespit edilemedi:", err);
    S.moveSystemDrives = [];
  }

  const curPath = s.installPath || "";
  const curDrive = curPath.length >= 2 && curPath[1] === ":" ? curPath[0].toUpperCase() : "";
  const installSize = s.installSize || 0;

  // Varsayılan hedef sürücü: Mevcut sürücü dışındaki ilk yeterli alana sahip sürücü
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

  // Varsayılan hedef klasör: seçilen sürücüde \Games
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
    speed: "Başlatılıyor…",
    eta: "Hesaplanıyor…",
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
      toast(res.message || "Oyun dosyaları başarıyla yeni konuma taşındı!", "ok");
      S.isMovingGame = false;
      closeMoveGameModal();

      // Diskten güncel kurulu oyunlar listesini tazele
      await refreshEpicInstalled();

      // Arka planda taze ayarları çek ve state'i senkronize tut
      try {
        const freshSettings = await epicGetGameSettings(appName);
        if (S.activeManageSettings && S.activeManageSettings.appName === appName) {
          S.activeManageSettings = freshSettings;
          updateManageModalInputsInPlace(freshSettings);
        }
      } catch {}

      // refreshEpicInstalled sonrası hafıza nesnesi yenilendiyse tekrar garantiye al
      if (newPath) {
        applyMovedGamePath(appName, newPath);
      }

      // Game Hub drawer açık ise arayüzü pürüzsüzce yeniden çiz
      if (S.currentModalAppName === appName) {
        openEpicModal(appName, false);
      }
    } else {
      toast(`Taşıma işlemi tamamlanamadı: ${res.message}`, "err");
      S.isMovingGame = false;
      renderMoveGameModalFrame();
    }
  } catch (err) {
    toast(`Taşıma hatası: ${String(err)}`, "err");
    S.isMovingGame = false;
    renderMoveGameModalFrame();
  }
}

export async function cancelMoveGame(appName: string): Promise<void> {
  try {
    await epicCancelMoveGame(appName);
    toast("Taşıma iptal ediliyor… Kaynak dosyalar güvende.", "");
  } catch (err) {
    toast(`İptal isteği gönderilemedi: ${String(err)}`, "err");
  }
}

/* ---------- Epic indirme ---------- */


