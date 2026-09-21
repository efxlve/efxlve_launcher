/**
 * Application bootstrap and Tauri IPC event listeners.
 *
 * Wires the render/HUD/modal buses, hydrates settings, registers every backend
 * event listener and starts the initial library load. main.ts calls this once
 * from its entry point.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CircleUserRound, Download, Gamepad2, LayoutGrid, Settings, Store, createIcons } from "lucide";
import {
  epicGetNetworkProfile,
  epicGetOfflineMode,
  epicGetPlaytimes,
  epicGetQueue,
  epicListSkipped,
  toEpicSlug,
  type DlProgressEvent,
  type DownloadCancelledEvent,
  type DownloadFailedEvent,
  type GameScreenshotItem,
  type GameStatusEvent,
  type LibraryEvent,
  type MoveGameProgress,
  type SetupEvent,
  type VerifyCompleteEvent,
  type VerifyProgressEvent,
} from "../../epic";
import { applyStaticTranslations, localizeMessage, setLanguage, t } from "../../i18n";
import { isTauri } from "../../core/constants";
import { modalRoot } from "../../core/dom";
import { gameById, refreshGames } from "../../core/demo";
import { refreshEpicInstalled } from "../../core/epic-actions";
import { icon } from "../../core/icons";
import { updateBadge, updateOfflineModeUi } from "../../core/nav";
import {
  registerCloseAllModals,
  registerGamepadHud,
  registerOpenEpicModal,
  registerRender,
  render,
} from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { fmtBytes, fmtPlaytime } from "../../core/utils";
import { updateMaxIcon } from "../../core/window";
import { bootEpic } from "../auth/auth-actions";
import { initContextMenu } from "../context-menu/context-menu";
import { drawSpeedCanvas, pushSpeedData, startSpeedChartTimer } from "../downloads/downloads-view";
import { openEpicModal } from "../drawer/drawer-view";
import { initGamepadSupport, updateGamepadHud } from "../gamepad/gamepad";
import { resetVerifyInPlace, updateVerifyProgressInPlace } from "../manage/manage-view";
import { applyMovedGamePath } from "../move-game/move-game-actions";
import { renderMoveGameModalFrame, updateMoveProgressInPlace } from "../move-game/move-game-view";
import {
  compressScreenshotItem,
  fetchAndRenderScreenshots,
  playScreenshotShutterSound,
  renderDrawerScreenshots,
} from "../screenshots/screenshots-view";
import { setView } from "../store/store-view";
export async function initApp(hooks: {
  render: () => void;
  scheduleRender: () => void;
  closeAllModals: () => void;
}): Promise<void> {
  updateMaxIcon();
  if (isTauri) {
    void invoke("app_set_decorations", { decorations: false }).catch(() => {});
  }
  createIcons({
    icons: { Store, LayoutGrid, Download, CircleUserRound, Settings, Gamepad2 },
  });
  // Load the selected language, apply its direction (LTR/RTL) and translate the static top bar.
  await setLanguage(S.appLanguage);
  applyStaticTranslations();
  updateOfflineModeUi();
  initContextMenu();
  registerRender(hooks.render, hooks.scheduleRender);
  registerCloseAllModals(hooks.closeAllModals);
  registerGamepadHud(updateGamepadHud);
  registerOpenEpicModal(openEpicModal);
  if (isTauri) {
    try {
      S.libraryPath = await invoke<string>("library_dir");
    } catch {
      S.libraryPath = t("common.unavailable");
    }
    try {
      S.epicSkippedCount = (await epicListSkipped()).length;
    } catch {
      S.epicSkippedCount = 0;
    }
    await listen<SetupEvent>("legendary-setup", (event) => {
      S.setupProgress = event.payload.progress ?? null;
      S.setupMessage = event.payload.message;
      if (event.payload.state === "error") toast(S.setupMessage, "err");
      if (S.view === "library") render();
    });
    await listen<LibraryEvent>("legendary-library", (event) => {
      S.epicBusyMsg = localizeMessage(event.payload.message);
    });
    await listen<DlProgressEvent>("download-progress", (event) => {
      const { id, progress, done, speed, speedBytes, diskSpeed, diskBytes, eta, downloadedBytes, totalBytes } = event.payload;
      const title =
        gameById(id)?.title ?? S.epicSummaries.find((s) => s.appName === id)?.title ?? id;

      if (!done) {
        const cur = S.downloads.get(id);
        if (cur) cur.progress = progress;
        else S.downloads.set(id, { progress, done: false, title });

        if (!S.activeDlMetrics || S.activeDlMetrics.id !== id) {
          S.activeDlMetrics = {
            id,
            title,
            progress,
            done: false,
            speed: speed ?? "—",
            speedBytes: speedBytes ?? 0,
            diskSpeed: diskSpeed ?? "—",
            diskBytes: diskBytes ?? 0,
            eta: eta ?? t("common.calculating"),
            downloadedBytes: downloadedBytes ?? 0,
            totalBytes: totalBytes ?? 0,
          };
        } else {
          S.activeDlMetrics.progress = progress;
          if (speed) S.activeDlMetrics.speed = speed;
          if (speedBytes !== undefined && speedBytes !== null) S.activeDlMetrics.speedBytes = speedBytes;
          if (diskSpeed) S.activeDlMetrics.diskSpeed = diskSpeed;
          if (diskBytes !== undefined && diskBytes !== null) S.activeDlMetrics.diskBytes = diskBytes;
          if (eta) S.activeDlMetrics.eta = eta;
          if (downloadedBytes) S.activeDlMetrics.downloadedBytes = downloadedBytes;
          if (totalBytes) S.activeDlMetrics.totalBytes = totalBytes;
        }
        pushSpeedData(speedBytes ?? 0, diskBytes ?? 0);

        updateBadge();

        // In-place library button/bar updates (Rule 15)
        document.querySelectorAll(`[data-dlbtn="${id}"]`).forEach((b) => {
          b.textContent = `%${progress}`;
        });
        document.querySelectorAll(`[data-dlbar="${id}"]`).forEach((b) => {
          (b as HTMLElement).style.width = `${progress}%`;
        });

        // In-place download hub updates (Rule 15)
        if (S.view === "downloads") {
          const pctEl = document.getElementById("dl-hero-pct");
          if (pctEl) pctEl.textContent = `%${Math.round(progress)}`;
          const fillEl = document.getElementById("dl-hero-fill");
          if (fillEl) fillEl.style.width = `${progress}%`;
          const netEl = document.getElementById("dl-stat-net");
          if (netEl && speed) netEl.textContent = speed;
          const diskEl = document.getElementById("dl-stat-disk");
          if (diskEl && diskSpeed) diskEl.textContent = diskSpeed;
          const etaEl = document.getElementById("dl-stat-eta");
          if (etaEl && eta) etaEl.textContent = eta;
          const bytesEl = document.getElementById("dl-stat-bytes");
          if (bytesEl && downloadedBytes) {
            bytesEl.textContent = `${fmtBytes(downloadedBytes)} / ${fmtBytes(totalBytes || 0)}`;
          }
          const curNetLegend = document.getElementById("dl-legend-net-val");
          if (curNetLegend && speed) curNetLegend.textContent = speed;
          const curDiskLegend = document.getElementById("dl-legend-disk-val");
          if (curDiskLegend && diskSpeed) curDiskLegend.textContent = diskSpeed;
          drawSpeedCanvas();
        }
        return;
      }

      // Download completed
      S.downloads.set(id, { progress: 100, done: true, title });
      if (S.activeDlMetrics?.id === id) {
        S.activeDlMetrics = null;
      }
      pushSpeedData(0, 0);
      updateBadge();
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        render();
      }).catch(() => render());
      if (S.epicSummaries.some((s) => s.appName === id)) void refreshEpicInstalled();
      else void refreshGames();
    });
    await listen<{ id: string }>("download-paused", (_event) => {
      S.dlQueueStatus.isPaused = true;
      if (S.view === "downloads") render();
    });
    await listen<DownloadFailedEvent>("download-failed", (event) => {
      S.downloads.delete(event.payload.id);
      if (S.activeDlMetrics?.id === event.payload.id) S.activeDlMetrics = null;
      updateBadge();
      toast(t("dl.downloadFailed", { msg: localizeMessage(event.payload.message) }), "err");
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads" || S.view === "library") render();
      });
    });
    await listen<DownloadCancelledEvent>("download-cancelled", (event) => {
      S.downloads.delete(event.payload.id);
      if (S.activeDlMetrics?.id === event.payload.id) S.activeDlMetrics = null;
      updateBadge();
      toast(t("dl.cancelled"), "");
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads" || S.view === "library") render();
      });
    });
    startSpeedChartTimer();
    window.addEventListener("resize", () => {
      if (S.view === "downloads") drawSpeedCanvas();
    });
    await listen<VerifyProgressEvent>("verify-progress", (event) => {
      const { id, current, total, percent, speed, detail } = event.payload;
      updateVerifyProgressInPlace(id, current, total, percent, speed, detail);
    });
    await listen<VerifyCompleteEvent>("verify-complete", (event) => {
      const { id, success, message } = event.payload;
      resetVerifyInPlace(id);
      if (success) {
        toast(t("verify.success"), "ok");
      } else {
        toast(t("verify.failed", { msg: localizeMessage(message) }), "err");
      }
    });

    await listen<MoveGameProgress>("move-progress", (event) => {
      const payload = event.payload;
      if (!payload || !S.activeMoveModalAppName) return;
      if (payload.id === S.activeMoveModalAppName) {
        S.activeMoveProgress = payload;
        if (S.isMovingGame) {
          updateMoveProgressInPlace(payload);
        }
      }
    });
    await listen<{ id?: string; success: boolean; newPath?: string; new_path?: string; message?: string }>(
      "move-complete",
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (payload.success && payload.id) {
          const np = payload.newPath || payload.new_path;
          if (np) {
            applyMovedGamePath(payload.id, np);
          }
        } else if (!payload.success && S.isMovingGame) {
          toast(t("move.failed", { msg: payload.message ? localizeMessage(payload.message) : t("common.error") }), "err");
          S.isMovingGame = false;
          renderMoveGameModalFrame();
        }
      }
    );

    await listen<{ appName?: string; title?: string; slug?: string }>(
      "efxlve-open-game-from-store",
      (event) => {
        const { appName, title, slug } = event.payload;
        setView("library");
        render();

        let targetApp = appName;
        if (!targetApp && (slug || title)) {
          const normTitle = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const match = S.epicSummaries.find((s) => {
            if (slug && toEpicSlug(s.title) === slug.toLowerCase()) return true;
            if (title && s.title.toLowerCase() === title.toLowerCase()) return true;
            if (normTitle && s.title.toLowerCase().replace(/[^a-z0-9]/g, "") === normTitle) return true;
            return false;
          });
          if (match) targetApp = match.appName;
        }

        if (targetApp) {
          openEpicModal(targetApp);
        } else if (title || slug) {
          const q = title || slug || "";
          S.query = q;
          render();
        }
      },
    );

    await listen<GameStatusEvent>("game-status", (event) => {
      const { id, running, sessionSeconds, totalSeconds, sessionCount, lastPlayed, lastPlayedTimestamp } = event.payload;
      const sum = S.epicSummaries.find((x) => x.appName === id);
      const title = sum?.title || id;

      if (running) {
        S.runningGames.add(id);
        toast(t("status.running", { title }), "ok");
      } else {
        S.runningGames.delete(id);
        if (totalSeconds !== undefined) {
          S.playtimeMap.set(id, {
            total_seconds: totalSeconds,
            session_count: sessionCount || 1,
            last_played: lastPlayed,
            last_played_timestamp: lastPlayedTimestamp,
          });
        }
        toast(
          sessionSeconds
            ? t("status.closedSession", { title, time: fmtPlaytime(sessionSeconds) })
            : t("status.closed", { title }),
          "",
        );
      }

      // Update buttons and badges.
      document.querySelectorAll<HTMLElement>(`[data-id="${id}"]`).forEach((el) => {
        if (el.dataset.act === "epic-play") {
          if (running) {
            el.classList.add("running");
            el.innerHTML = `<span class="running-dot"></span> ${t("common.playing")}`;
          } else {
            el.classList.remove("running");
            el.innerHTML = `${icon("play", 14)} Oyna`;
          }
        }
      });

      if (S.view === "library") {
        render();
      }

      if (S.currentModalAppName === id && (S.activeDrawerTab === "overview" || S.activeDrawerTab === "manage")) {
        openEpicModal(id, false);
      }
    });

    await listen<{ id: string; count: number }>("screenshots-updated", (event) => {
      const { id, count } = event.payload;
      if (count > 0) {
        toast(t("ss.newCaptures", { count }), "ok");
        const s = S.epicSummaries.find((x) => x.appName === id);
        const title = s ? s.title : id;
        void fetchAndRenderScreenshots(id, title, true);
      }
    });

    await listen<{ id: string; title: string }>(
      "screenshot-shutter",
      (event) => {
        playScreenshotShutterSound();
        const sum = S.epicSummaries.find((x) => x.appName === event.payload.id);
        const title = sum?.title || event.payload.title || "Oyun";
        toast(t("ss.capturingTitle", { title }), "ok");
      }
    );

    await listen<{ id: string; title: string; item: GameScreenshotItem }>(
      "screenshot-captured",
      (event) => {
        const { id, item } = event.payload;
        toast(t("ss.saved", { file: item.file_name }), "ok");

        const existing = S.loadedScreenshots.get(id) || [];
        S.loadedScreenshots.set(id, [item, ...existing.filter((x) => x.file_path !== item.file_path)]);

        if (S.currentModalAppName === id) {
          const list = S.loadedScreenshots.get(id) || [];
          const badgeEl = modalRoot.querySelector('.drawer-tab[data-tab="screenshots"] .drawer-tab-badge');
          const tabBtn = modalRoot.querySelector('.drawer-tab[data-tab="screenshots"]');
          if (badgeEl) {
            badgeEl.textContent = `(${list.length})`;
          } else if (tabBtn) {
            tabBtn.insertAdjacentHTML("beforeend", ` <span class="drawer-tab-badge">(${list.length})</span>`);
          }

          if (S.activeDrawerTab === "screenshots") {
            const contentEl = document.getElementById("drawer-tab-content");
            const curSummary = S.epicSummaries.find((x) => x.appName === id);
            if (contentEl && curSummary) {
              contentEl.innerHTML = renderDrawerScreenshots(curSummary);
            }
          }
        }

        if (S.screenshotCompressionEnabled) {
          void compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, false);
        }
      }
    );

    await listen<{ id: string; success: boolean }>("cloud-sync-complete", () => {
      toast(t("manage.cloudSynced"), "ok");
      const cloudSub = document.getElementById("manage-cloud-subtitle");
      if (cloudSub) cloudSub.textContent = t("manage.cloudUpToDate");
    });

    try {
      const pt = await epicGetPlaytimes();
      S.playtimeMap = new Map(Object.entries(pt));
    } catch {
      // ignore
    }
    try {
      S.offlineMode = await epicGetOfflineMode();
      updateOfflineModeUi();
    } catch {
      // ignore
    }
    try {
      S.networkProfile = await epicGetNetworkProfile();
    } catch {
      // ignore
    }
  }
  await refreshGames();
  initGamepadSupport();
  void bootEpic();
}
