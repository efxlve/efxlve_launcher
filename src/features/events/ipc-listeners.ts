/**
 * Application bootstrap and Tauri IPC event listeners.
 *
 * Wires the render/HUD/modal buses, hydrates settings, registers every backend
 * event listener and starts the initial library load. main.ts calls this once
 * from its entry point.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bell, CircleUserRound, Download, LayoutGrid, Monitor, Settings, ShoppingBag, Store, createIcons } from "lucide";
import {
  epicBackupSave,
  epicCreateDesktopShortcut,
  epicGetAutoDesktopShortcut,
  epicGetNetworkProfile,
  epicGetSettings,
  epicGetOfflineMode,
  epicGetPlaytimes,
  epicGetQueue,
  epicListSkipped,
  epicPauseDownload,
  epicResumeDownload,
  epicTakePendingLaunch,
  controllerBridgeStart,
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
import { localizeMessage, setLanguage, t } from "../../i18n";
import { gogPauseDownload, gogResumeDownload } from "../../gog";
import { loadNotifications, pushNotification } from "../notifications/notifications";
import { initAutoUpdate } from "../downloads/auto-update";
import { installArtFallback } from "../library/art-fallback";
import { initAppUpdater } from "../updates/update-manager";
import { CONTROLLER_BRIDGE_KEY, AUTOSTART_INIT_KEY, isTauri } from "../../core/constants";
import { appMinimize, appSetAutostart } from "../../core/window";
import { modalRoot } from "../../core/dom";

import { refreshEpicInstalled, epicPlay } from "../../core/epic-actions";
import { loadSharedLibrary } from "../library/shared-library";
import { loadSteamLibrary, refreshSteamInstalled, startSteamLibraryWatch } from "../library/steam-library";
import { loadCompanionLibrary, syncCompanionAccounts } from "../library/companion-library";
import { syncEpicServerPlaytimes } from "../../core/epic-playtime";
import { patchLibraryCardDom } from "../../core/game-view";
import { libraryItemOf, rebuildAllGamesMap, summaryOf } from "../../core/selectors";
import { icon } from "../../core/icons";
import { updateBadge, updateOfflineModeUi } from "../../core/nav";
import { pushRecentInstall } from "../../core/recent";
import {
  registerCloseAllModals,
  registerGamepadHud,
  registerNotify,
  registerOpenEpicModal,
  registerPresenceSync,
  registerRender,
  render,
} from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { fmtBytes, fmtPlaytime, fmtSpeed } from "../../core/utils";
import { updateMaxIcon } from "../../core/window";
import { refreshSidebarToggle } from "../../core/sidebar-layout";
import { bootEpic } from "../auth/auth-actions";
import { initGogSession, syncGogPlaytime } from "../auth/gog-auth-actions";
import { hydrateSteamAuth } from "../auth/steam-auth-actions";
import { loadSavedAccounts } from "../auth/account-switcher";
import { initCloudBackupSettings } from "../cloud-backup/cloud-backup-actions";
import { initContextMenu } from "../context-menu/context-menu";
import { initCollectionTabs } from "../library/library-view";
import { drawSpeedCanvas, pushSpeedData, scheduleDrawSpeedCanvas, startSpeedChartTimer, stopSpeedChartTimer } from "../downloads/downloads-view";
import { openEpicModal } from "../drawer/drawer-view";
import { initGamepadSupport, updateGamepadHud } from "../gamepad/gamepad";
import { resetVerifyInPlace, updateVerifyProgressInPlace } from "../manage/manage-view";
import { applyMovedGamePath } from "../move-game/move-game-actions";
import { initEosInstall } from "../eos/eos-install";
import { initPresence, syncPresence } from "../presence/presence";
import { renderMoveGameModalFrame, updateMoveProgressInPlace } from "../move-game/move-game-view";
import {
  compressScreenshotItem,
  fetchAndRenderScreenshots,
  playScreenshotShutterSound,
  renderDrawerScreenshots,
  renderMomentsStrip,
} from "../screenshots/screenshots-view";
import { setView } from "../store/store-view";

let dlDomRaf = 0;
let dlDomId = "";
let lastDlSample: { id: string; bytes: number; at: number } | null = null;

/** Batches bursty download DOM updates into a single animation frame. */
function scheduleDlDomUpdate(id: string): void {
  dlDomId = id;
  if (dlDomRaf) return;
  dlDomRaf = requestAnimationFrame(() => {
    dlDomRaf = 0;
    applyDlDomUpdate(dlDomId);
  });
}

/** Patches the existing download nodes. Do not assign `innerHTML` on this path. */
function applyDlDomUpdate(id: string): void {
  const dl = S.downloads.get(id);
  const progress = dl ? dl.progress : 100;
  updateBadge("progress");
  document.querySelectorAll(`[data-dlbtn="${id}"]`).forEach((b) => {
    b.textContent = t("common.downloading", { p: Math.round(progress) });
  });
  document.querySelectorAll(`[data-dlbar="${id}"]`).forEach((b) => {
    (b as HTMLElement).style.width = `${progress}%`;
  });
  const chip = document.querySelector(".tv-status-chip.is-dl .tv-dl-speed");
  if (chip) {
    const speed = S.activeDlMetrics?.speedBytes ?? 0;
    chip.textContent = speed > 0 ? `${fmtBytes(speed)}/s` : `%${Math.round(progress)}`;
  }

  if (S.view !== "downloads" && !document.getElementById("tv-dl-list")) return;
  const pctEl = document.getElementById("dl-hero-pct");
  if (pctEl) pctEl.textContent = `%${Math.round(progress)}`;
  const fillEl = document.getElementById("dl-hero-fill");
  if (fillEl) fillEl.style.width = `${progress}%`;

  const m = S.activeDlMetrics;
  if (!m) return;
  const netText = fmtSpeed(m.speedBytes, S.speedInBits);
  const diskText = fmtSpeed(m.diskBytes, S.speedInBits);
  const netEl = document.getElementById("dl-stat-speed");
  if (netEl) netEl.textContent = netText;
  const peakEl = document.getElementById("dl-stat-peak");
  if (peakEl) peakEl.textContent = fmtSpeed(S.peakNetSpeedBytes, S.speedInBits);
  const diskEl = document.getElementById("dl-stat-disk");
  if (diskEl) diskEl.textContent = diskText;
  const etaEl = document.getElementById("dl-stat-eta");
  if (etaEl && m.eta) etaEl.textContent = localizeMessage(m.eta);
  const bytesEl = document.getElementById("dl-stat-bytes");
  if (bytesEl && m.downloadedBytes) bytesEl.textContent = `${fmtBytes(m.downloadedBytes)} / ${fmtBytes(m.totalBytes)}`;
  const netLegend = document.getElementById("dl-legend-net-val");
  if (netLegend) netLegend.textContent = netText;
  const diskLegend = document.getElementById("dl-legend-disk-val");
  if (diskLegend) diskLegend.textContent = diskText;
  scheduleDrawSpeedCanvas();
}

export async function initApp(hooks: {
  render: () => void;
  scheduleRender: () => void;
  closeAllModals: () => void;
}): Promise<void> {
  installArtFallback();
  updateMaxIcon();
  createIcons({
    icons: { Store, ShoppingBag, LayoutGrid, Download, CircleUserRound, Settings, Bell, Monitor },
  });
  loadNotifications();
  initAutoUpdate();
  updateOfflineModeUi();
  initContextMenu();
  initCollectionTabs();
  registerRender(hooks.render, hooks.scheduleRender);
  registerCloseAllModals(hooks.closeAllModals);
  registerGamepadHud(updateGamepadHud);
  registerOpenEpicModal(openEpicModal);
  registerPresenceSync(syncPresence);
  registerNotify((input) => pushNotification(input));

  // The selected language may lazy-load a small local chunk (non-bundled locales).
  // tr/en are bundled, so this resolves without a real await for most users.
  await setLanguage(S.appLanguage);
  refreshSidebarToggle();

  // FIRST PAINT: paint the shell (skeleton) before any slow IPC so the window is
  // never blank on startup.
  hooks.render();

  // Kick off the library load immediately: it must not wait for listener
  // registration, settings fetches or window-chrome IPC.
  initGamepadSupport();
  // Re-arm the XInput bridge when the user left it on last session.
  // HidApi enumeration races WebView2's own device scan during the first
  // paint and can leave the window on the library skeleton, not responding.
  if (localStorage.getItem(CONTROLLER_BRIDGE_KEY) === "true") {
    window.setTimeout(() => {
      void controllerBridgeStart().catch(() => {});
    }, 4000);
  }
  // Start with Windows defaults to on; the marker keeps a user's choice.
  if (!localStorage.getItem(AUTOSTART_INIT_KEY)) {
    void appSetAutostart(true)
      .then(() => localStorage.setItem(AUTOSTART_INIT_KEY, "true"))
      .catch(() => {});
  }
  void bootEpic();
  void initGogSession();
  void hydrateSteamAuth();
  void loadSavedAccounts();
  void initCloudBackupSettings();

  if (isTauri) {
    void initEosInstall();
    void initAppUpdater();
    void invoke("app_set_decorations", { decorations: false }).catch(() => {});
    void invoke("app_set_minimize_to_tray", { enabled: S.minimizeToTray }).catch(() => {});
    void invoke("app_set_tray_labels", { show: t("tray.show"), quit: t("tray.quit") }).catch(() => {});
    void initPresence();
    void invoke<string>("library_dir")
      .then((p) => { S.libraryPath = p; })
      .catch(() => { S.libraryPath = t("common.unavailable"); });
    void epicListSkipped()
      .then((s) => { S.epicSkippedCount = s.length; })
      .catch(() => { S.epicSkippedCount = 0; });
    await listen<SetupEvent>("legendary-setup", (event) => {
      S.setupProgress = event.payload.progress ?? null;
      S.setupMessage = localizeMessage(event.payload.message);
      if (event.payload.state === "error") toast(S.setupMessage, "err");
      if (S.view === "library") render();
    });
    await listen<LibraryEvent>("legendary-library", (event) => {
      S.epicBusyMsg = localizeMessage(event.payload.message);
    });
    await listen<DlProgressEvent>("download-progress", (event) => {
      const { id, progress, done, speed, speedBytes, diskSpeed, diskBytes, eta, downloadedBytes, totalBytes } = event.payload;
      if (id.startsWith("gog::") && done) S.gogDlPaused = false;
      if (id.startsWith("gog::") && progress === 0 && !done) S.gogDlPaused = false;
      const title = libraryItemOf(id)?.title ?? S.epicSummariesMap.get(id)?.title ?? id;
      const now = performance.now();
      const sampleBytes = downloadedBytes ?? (
        totalBytes && totalBytes > 0
          ? Math.round(totalBytes * Math.max(0, Math.min(100, progress)) / 100)
          : null
      );
      // A missing or zero sample must not wipe the last real rate. Legendary
      // often repeats the same byte total between speed lines.
      let measuredSpeedBytes = speedBytes && speedBytes > 0 ? speedBytes : 0;
      let freshNet = measuredSpeedBytes > 0;
      if (sampleBytes !== null) {
        if (lastDlSample?.id === id) {
          const elapsed = (now - lastDlSample.at) / 1000;
          const delta = sampleBytes - lastDlSample.bytes;
          // Progress output can arrive in a burst; tiny intervals create fake
          // multi-gigabyte speeds when the same byte block is reported twice.
          if (!freshNet && elapsed >= 0.25 && delta > 0) {
            measuredSpeedBytes = Math.round(delta / elapsed);
            freshNet = true;
          }
        }
        lastDlSample = { id, bytes: sampleBytes, at: now };
      }
      const measuredDiskBytes = Math.min(diskBytes ?? 0, 1024 * 1024 * 1024);
      const freshDisk = measuredDiskBytes > 0;
      if (!done) startSpeedChartTimer();

      if (!done) {
        const cur = S.downloads.get(id);
        if (cur) cur.progress = progress;
        else S.downloads.set(id, { progress, done: false, title });

        if (!S.activeDlMetrics || S.activeDlMetrics.id !== id) {
          S.peakNetSpeedBytes = 0;
          S.speedHistory.fill(0);
          S.diskHistory.fill(0);
          S.activeDlMetrics = {
            id,
            title,
            progress,
            done: false,
            speed: speed ?? "—",
            speedBytes: measuredSpeedBytes,
            diskSpeed: diskSpeed ?? "—",
            diskBytes: freshDisk ? measuredDiskBytes : 0,
            eta: eta ?? t("common.calculating"),
            downloadedBytes: downloadedBytes ?? 0,
            totalBytes: totalBytes ?? 0,
          };
        } else {
          S.activeDlMetrics.progress = progress;
          if (speed) S.activeDlMetrics.speed = speed;
          if (freshNet) S.activeDlMetrics.speedBytes = measuredSpeedBytes;
          if (diskSpeed) S.activeDlMetrics.diskSpeed = diskSpeed;
          if (freshDisk) S.activeDlMetrics.diskBytes = measuredDiskBytes;
          if (eta) S.activeDlMetrics.eta = eta;
          if (downloadedBytes) S.activeDlMetrics.downloadedBytes = downloadedBytes;
          if (totalBytes) S.activeDlMetrics.totalBytes = totalBytes;
        }
        pushSpeedData(
          freshNet ? measuredSpeedBytes : S.activeDlMetrics.speedBytes,
          freshDisk ? measuredDiskBytes : S.activeDlMetrics.diskBytes,
        );

        // All DOM writes are batched to one rAF so bursty progress events never
        // cause repeated DOM writes to the sidebar counter and download bars.
        scheduleDlDomUpdate(id);
        return;
      }

      // Download completed
      S.downloads.set(id, { progress: 100, done: true, title });
      pushRecentInstall(id);
      lastDlSample = null;
      pushNotification({ kind: "download", title: t("notif.downloadDone", { title }), appName: id });
      // Per-install shortcut request from the install dialog (deferred until the
      // game files actually exist).
      if (S.pendingShortcutApps.has(id)) {
        S.pendingShortcutApps.delete(id);
        void epicCreateDesktopShortcut(id)
          .then(() => pushNotification({ kind: "info", title: t("manage.shortcutCreated", { a1: title }), appName: id }))
          .catch(() => pushNotification({ kind: "error", title: t("manage.shortcutFailed", { msg: title }) }));
      }
      if (S.activeDlMetrics?.id === id) {
        S.activeDlMetrics = null;
      }
      S.speedHistory.fill(0);
      S.diskHistory.fill(0);
      stopSpeedChartTimer();
      updateBadge();
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
        else if (S.view === "library") patchLibraryCardDom(id);
      }).catch(() => {
        if (S.view === "downloads") render();
        else if (S.view === "library") patchLibraryCardDom(id);
      });
      if (id.startsWith("gog::")) {
        const cleanId = id.slice(5);
        const item = S.gogSummariesMap.get(cleanId) || S.gogSummariesMap.get(id);
        if (item) {
          item.installed = true;
          rebuildAllGamesMap();
          if (S.view === "library") patchLibraryCardDom(id);
        }
      } else if (Boolean(summaryOf(id))) {
        void refreshEpicInstalled().then(() => {
          if (S.view === "library") patchLibraryCardDom(id);
        });
      }
    });
    await listen<{ id: string }>("download-paused", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = true;
      else S.dlQueueStatus.isPaused = true;
      lastDlSample = null;
      if (S.activeDlMetrics) {
        S.activeDlMetrics.speedBytes = 0;
        S.activeDlMetrics.diskBytes = 0;
      }
      if (S.view === "downloads") render();
    });
    await listen<{ id: string }>("download-resumed", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = false;
      else S.dlQueueStatus.isPaused = false;
      if (S.view === "downloads") render();
    });
    await listen<DownloadFailedEvent>("download-failed", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = false;
      S.downloads.delete(event.payload.id);
      if (S.activeDlMetrics?.id === event.payload.id) S.activeDlMetrics = null;
      S.speedHistory.fill(0);
      S.diskHistory.fill(0);
      stopSpeedChartTimer();
      updateBadge();
      const failTitle = libraryItemOf(event.payload.id)?.title ?? summaryOf(event.payload.id)?.title ?? event.payload.id;
      pushNotification({
        kind: "error",
        title: t("notif.downloadFailed", { title: failTitle }),
        body: localizeMessage(event.payload.message),
        appName: event.payload.id,
      });
      toast(t("dl.downloadFailed", { msg: localizeMessage(event.payload.message) }), "err");
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
        else if (S.view === "library") patchLibraryCardDom(event.payload.id);
      });
    });
    await listen<DownloadCancelledEvent>("download-cancelled", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = false;
      S.downloads.delete(event.payload.id);
      if (S.activeDlMetrics?.id === event.payload.id) S.activeDlMetrics = null;
      S.speedHistory.fill(0);
      S.diskHistory.fill(0);
      stopSpeedChartTimer();
      updateBadge();
      toast(t("dl.cancelled"), "");
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
        else if (S.view === "library") patchLibraryCardDom(event.payload.id);
      });
    });
    // Speed chart timer runs on-demand only during active downloads
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
      const sum = summaryOf(id);
      const title = sum?.title || id;

      if (running) {
        S.runningGames.add(id);
        toast(t("status.running", { title }), "ok");
        // Opt-in: get the launcher out of the way when a game starts. TV Mode
        // is a fullscreen couch UI and stays where it is.
        if (S.minimizeOnGame && S.view !== "tv") {
          void appMinimize().catch(() => {});
        }
        // Opt-in: pause the active download while a game is running so it does not
        // steal bandwidth/disk from gameplay. Covers Epic and GOG downloads, and
        // never touches a pause the user asked for.
        const pausedNow = S.dlQueueStatus.isPaused || S.gogDlPaused;
        if (S.pauseOnPlay && !S.autoPausedDl && !pausedNow) {
          const activeId = S.activeDlMetrics && !S.activeDlMetrics.done
            ? S.activeDlMetrics.id
            : [...S.downloads.entries()].find(([, d]) => !d.done)?.[0];
          if (activeId) {
            const isGog = activeId.startsWith("gog::");
            void (isGog ? gogPauseDownload(activeId) : epicPauseDownload(activeId))
              .then(() => {
                S.autoPausedDl = activeId;
                if (isGog) S.gogDlPaused = true;
                else S.dlQueueStatus.isPaused = true;
              })
              .catch(() => {});
          }
        }
      } else {
        S.runningGames.delete(id);
        if (totalSeconds !== undefined) {
          // The local counter only knows the sessions this launcher started.
          // Replacing the map with it would drop a 300h game to 1h, so the
          // shown value is the higher of the two (Epic's hours never shrink).
          const shownSeconds = S.playtimeMap.get(id)?.total_seconds ?? 0;
          S.playtimeMap.set(id, {
            total_seconds: Math.max(totalSeconds, shownSeconds),
            session_count: sessionCount || 1,
            last_played: lastPlayed,
            last_played_timestamp: lastPlayedTimestamp,
          });
          // Pull Epic's fresh total now; max() keeps it safe if Epic lags behind.
          // GOG and Steam hours come from their own local sources below/at boot.
          if (!id.startsWith("gog::") && !id.startsWith("steam::")) void syncEpicServerPlaytimes(true);
          // GOG hours live in Galaxy's local database (read-only import).
          if (id.startsWith("gog::")) void syncGogPlaytime();
        }
        toast(
          sessionSeconds
            ? t("status.closedSession", { title, time: fmtPlaytime(sessionSeconds) })
            : t("status.closed", { title }),
          "",
        );
        // Resume a download this rule paused, once no game is running anymore and
        // the user has not resumed it manually in the meantime.
        if (S.autoPausedDl && S.runningGames.size === 0) {
          const resumeId = S.autoPausedDl;
          const isGog = resumeId.startsWith("gog::");
          const stillPaused = isGog ? S.gogDlPaused : S.dlQueueStatus.isPaused;
          if (stillPaused) {
            S.autoPausedDl = null;
            void (isGog ? gogResumeDownload(resumeId) : epicResumeDownload(resumeId))
              .then(() => {
                if (isGog) S.gogDlPaused = false;
                else S.dlQueueStatus.isPaused = false;
              })
              .catch(() => {});
          }
        }
        // Opt-in: back up local saves when the game closes.
        if (S.autoBackupOnExit && S.epicSummariesMap.get(id)?.installed) {
          void epicBackupSave(id)
            .then(() => pushNotification({ kind: "info", title: t("notif.backupLocalDone", { title }), appName: id }))
            .catch((err) => {
              const msg = String(err);
              // No recorded save folder is not a failed cloud sync.
              if (msg.includes("backup.noSaveDir") || msg.includes("backup.saveDirMissing")) return;
              pushNotification({ kind: "error", title: t("notif.backupFailed", { title }), appName: id });
            });
        }
      }

      // Update buttons and badges.
      document.querySelectorAll<HTMLButtonElement>(`button[data-act="epic-play"][data-id="${CSS.escape(id)}"], button[data-act="epic-stop"][data-id="${CSS.escape(id)}"]`).forEach((el) => {
        if (el.classList.contains("pcard-play-btn")) return;
        if (el.dataset.act === "epic-play" || el.dataset.act === "epic-stop") {
          if (running) {
            el.dataset.act = "epic-stop";
            el.classList.add("running");
            el.innerHTML = `<span class="running-dot"></span> ${t("common.playing")}`;
          } else {
            el.dataset.act = "epic-play";
            el.classList.remove("running");
            el.innerHTML = `${icon("play", 14)} ${t("common.play")}`;
          }
        }
      });

      if (S.view === "library") {
        patchLibraryCardDom(id);
      }

      if (S.currentModalAppName === id && (S.activeDrawerTab === "overview" || S.activeDrawerTab === "manage")) {
        openEpicModal(id, false);
      }
    });

    await listen<{ id: string; count: number }>("screenshots-updated", (event) => {
      const { id, count } = event.payload;
      if (count > 0) {
        toast(t("ss.newCaptures", { count }), "ok");
        const s = summaryOf(id);
        const title = s ? s.title : id;
        void fetchAndRenderScreenshots(id, title, true);
      }
    });

    await listen<{ id: string; title: string }>(
      "screenshot-shutter",
      (event) => {
        playScreenshotShutterSound();
        const sum = summaryOf(event.payload.id);
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
            const curSummary = summaryOf(id);
            if (contentEl && curSummary) {
              contentEl.innerHTML = renderDrawerScreenshots(curSummary);
            }
          } else if (S.activeDrawerTab === "overview") {
            const moments = document.getElementById("gp-moments");
            if (moments) moments.outerHTML = renderMomentsStrip(id);
          }
        }

        if (S.screenshotCompressionEnabled) {
          // Compression is on by default now, so the automatic pass stays silent:
          // "capturing" + "saved" toasts are enough feedback for one hotkey press.
          void compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, true);
        }
      }
    );

    await listen<{ id: string; success: boolean; message?: string }>("cloud-sync-complete", (event) => {
      const cloudSub = document.getElementById("manage-cloud-subtitle");
      const title = libraryItemOf(event.payload.id)?.title ?? S.epicSummariesMap.get(event.payload.id)?.title;
      if (event.payload.success) {
        if (cloudSub) cloudSub.textContent = t("manage.cloudUpToDate");
        // A successful upload is an event worth keeping; the toast alone vanishes.
        if (title && event.payload.success && S.cloudBackupSettings?.enabled && S.cloudBackupSettings.provider !== "none") {
          pushNotification({ kind: "info", title: t("notif.backupCloudDone", { title }), appName: event.payload.id });
        }
        return;
      }
      // A failed automatic cloud upload must not vanish while the game closes.
      const detail = localizeMessage(event.payload.message || "");
      toast(detail || t("backup.failed", { msg: "" }), "err");
      if (title) pushNotification({ kind: "error", title: t("notif.cloudSyncFailed", { title }), body: detail, appName: event.payload.id });
    });

    await listen("steam-library-changed", () => {
      void refreshSteamInstalled();
    });

    try {
      const pt = await epicGetPlaytimes();
      S.playtimeMap = new Map(Object.entries(pt));
      S.libraryDataRev++;
      if (S.view === "library" && S.showCoverStats) hooks.scheduleRender();
      // Epic's server snapshot fills in the hours played outside this launcher.
      void syncEpicServerPlaytimes();
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
    try {
      S.preferredCdn = (await epicGetSettings()).preferred_cdn ?? "";
      S.autoDesktopShortcut = await epicGetAutoDesktopShortcut();
    } catch {
      // ignore
    }

    // Other accounts' games come from disk snapshots (no network) so the shared
    // library is ready as soon as the shell paints.
    void loadSharedLibrary();

    // Steam games come from the Steam client's own manifests on this PC.
    void loadSteamLibrary().then(() => startSteamLibraryWatch());
    void loadCompanionLibrary();
    // Linked companion accounts refresh in the background (Ubisoft session).
    void syncCompanionAccounts();

    // Desktop shortcuts start the launcher with `--launch <app>`: hand it to the
    // same play path as the Play button once the shell is up.
    try {
      const pending = await epicTakePendingLaunch();
      if (pending) window.setTimeout(() => void epicPlay(pending), 1200);
    } catch {
      // ignore
    }
  }
}
