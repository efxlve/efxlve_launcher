/**
 * Application bootstrap and Tauri IPC event listeners.
 *
 * Wires the render/HUD/modal buses, hydrates settings, registers every backend
 * event listener and starts the initial library load. main.ts calls this once
 * from its entry point.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bell, CircleUserRound, Clapperboard, Download, Image, LayoutGrid, Monitor, Music, NotebookPen, Settings, ShoppingBag, Store, createIcons } from "lucide";
import {
  epicBackupSave,
  epicCreateDesktopShortcut,
  epicDefaultInstallDir,
  epicGetAutoDesktopShortcut,
  epicGetNetworkProfile,
  epicGetSettings,
  epicGetOfflineMode,
  epicGetPlaytimes,
  epicGetQueue,
  epicGetSystemDrives,
  epicListSkipped,
  epicPauseDownload,
  epicPrepareComet,
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
import { localizeMessage, formatSyncStamp, setLanguage, t } from "../../i18n";
import { noteDiscordMessage, setDiscordInCall, updatePageHeader } from "../../core/nav";
import { getVersion } from "@tauri-apps/api/app";
import { eglLauncherPresent } from "../../egl-removal";
import { gogPauseDownload, gogResumeDownload } from "../../gog";
import { loadNotifications, pushNotification } from "../notifications/notifications";
import { initAutoUpdate } from "../downloads/auto-update";
import { installArtFallback } from "../library/art-fallback";
import { initAppUpdater } from "../updates/update-manager";
import { CONTROLLER_BRIDGE_KEY, AUTOSTART_INIT_KEY, OVERLAY_ENABLED_KEY, OVERLAY_HUD_KEY, OVERLAY_DISABLED_KEY, isTauri } from "../../core/constants";
import { overlayEnabled, overlayHotkey, overlayHotkeyLabel } from "../../core/page-visibility";
import { appMinimize, appSetAutostart } from "../../core/window";
import { modalRoot } from "../../core/dom";

import { clearLaunchStatus, refreshEpicInstalled, epicPlay, updateLaunchStatus } from "../../core/epic-actions";
import { loadSharedLibrary } from "../library/shared-library";
import { loadSteamLibrary, refreshSteamInstalled, startSteamLibraryWatch } from "../library/steam-library";
import { syncInstalledWatch } from "../library/installed-watch";
import { loadCompanionLibrary, syncCompanionAccounts } from "../library/companion-library";
import { loadCustomGamesLibrary } from "../custom-games/custom-games-library";
import { syncEpicServerPlaytimes } from "../../core/epic-playtime";
import { patchLibraryCardDom } from "../../core/game-view";
import { libraryItemOf, rebuildAllGamesMap, summaryOf } from "../../core/selectors";
import { BRAND_ICONS, icon } from "../../core/icons";
import { updateBadge, updateOfflineModeUi } from "../../core/nav";
import { pushRecentInstall, pushRecent } from "../../core/recent";
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
import { loadAmazonSession, loadAmazonInstallDir } from "../auth/amazon-auth-actions";
import { amazonKey, type NileProgressEvent } from "../../nile";
import { hydrateSteamAuth } from "../auth/steam-auth-actions";
import { unwatchSteamAchievements, watchSteamAchievements } from "../../core/steam-watch";
import { loadSavedAccounts } from "../auth/account-switcher";
import { initCloudBackupSettings, scheduleLocalBackups } from "../cloud-backup/cloud-backup-actions";
import { scheduleProfileUploads } from "../cloud-backup/profile-sync-actions";
import { initContextMenu } from "../context-menu/context-menu";
import { initCollectionTabs, refreshLibraryResultsInPlace } from "../library/library-view";
import { syncCaseCustomStoreColors } from "../library/case-colors";
import { drawSpeedCanvas, pushSpeedData, scheduleDrawSpeedCanvas, startSpeedChartTimer, stopSpeedChartTimer } from "../downloads/downloads-view";
import {
  fetchAndRenderAchievements,
  openEpicModal,
  paintGameMeta,
  refreshAchievementsAfterSession,
  startStoreAchievementSession,
} from "../drawer/drawer-view";
import { rememberCloudSync } from "../drawer/drawer-widgets";
import { initGamepadSupport, updateGamepadHud } from "../gamepad/gamepad";
import { resetVerifyInPlace, updateManageSyncBar, updateVerifyProgressInPlace } from "../manage/manage-view";
import { checkMtuAfterSyncFailure } from "../manage/mtu-guard";
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
import { setMediaScanProgress } from "../screenshots/screenshots-page";
import { setView } from "../store/store-view";
import { ensureNotesMigration } from "../notes/notes-client";
import { ssCleanupPolicy, ssNotifyOn, ssSetCleanupPolicy, ssSoundOn } from "../screenshots/ss-settings";
import { perfMark } from "../../core/perf";
import { initOfflineMode } from "../../core/offline";
import { pushClipSettings } from "../screenshots/ss-settings";
import { notifyBackgrounded } from "../../core/system-notify";
import { prefetchRecentPicturesWhenIdle } from "../../core/picture-cache";
import { initHoverPrefetch, prefetchGamePagesWhenIdle, prefetchVisibleAchievements } from "../drawer/game-prefetch";
import { feedbackRecoveryPending } from "../../feedback";
import { openFeedback } from "../feedback/feedback-view";

/** A game seen this soon after boot was usually already open before the launcher. */
const GAME_WATCH_BOOT_GRACE_MS = 12_000;
const GAME_WATCH_BOOT_AT = Date.now();

let dlDomRaf = 0;
let dlDomId = "";
let lastDlSample: { id: string; bytes: number; at: number } | null = null;

/** Overlay per-game opt-out list (written by the overlay settings tab). */
function overlayDisabledFor(appName: string): boolean {
  try {
    const raw = localStorage.getItem(OVERLAY_DISABLED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return false;
    return list.some((item) =>
      typeof item === "string" ? item === appName : (item as { key?: string })?.key === appName,
    );
  } catch {
    return false;
  }
}

/**
 * Boot sync for the overlay service: whether it may run at all and which key
 * opens it. The backend tears the panel window down when this says off.
 */
function syncOverlayService(): void {
  void invoke("overlay_set_enabled", { enabled: overlayEnabled() }).catch(() => {});
  void invoke("overlay_set_hotkey", { spec: overlayHotkey() }).catch(() => {});
}

/** "Shift + Tab" for the hint text, matching the configured hotkey. */

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

/**
 * Boot listeners register in one parallel batch.
 *
 * Every `listen` is an IPC round trip; 23 of them, awaited one by one, cost
 * ~900 ms of the boot path before the library could paint. They are collected
 * here and flushed together, which keeps the semantics (all registered before
 * the launcher is interactive) without the serial latency.
 */
const bootListeners: Promise<unknown>[] = [];

function listenLater<T>(event: string, handler: (event: { payload: T }) => void): void {
  bootListeners.push(listen<T>(event, handler));
}

export async function initApp(hooks: {
  render: () => void;
  scheduleRender: () => void;
  closeAllModals: () => void;
}): Promise<void> {
  installArtFallback();
  syncCaseCustomStoreColors();
  updateMaxIcon();
  // The window bar version comes from the bundle, not from a literal that has
  // to be remembered on every release.
  void getVersion()
    .then((version) => {
      if (!version) return;
      S.appVersion = version;
      updatePageHeader();
    })
    .catch(() => {});
  // The overlay must know its switch state before anything else, because the
  // backend tears the panel window down when it is off.
  syncOverlayService();
  createIcons({
    icons: { Store, ShoppingBag, LayoutGrid, Download, CircleUserRound, Settings, Bell, Monitor, Music, NotebookPen, Image, Clapperboard, ...BRAND_ICONS },
  });
  loadNotifications();
  initAutoUpdate();
  // The overlay's old localStorage notes move into `<app_data>/notes.json`
  // once; the overlay itself also runs this, the file guards the race.
  void ensureNotesMigration();
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
  perfMark("paint:shell");

  // Kick off the library load immediately: it must not wait for listener
  // registration, settings fetches or window-chrome IPC.
  initGamepadSupport();
  // Offline mode gates every network call the boot makes; the flag is read in
  // parallel with the paint above (anything network-bound awaits `offlineReady`),
  // so the disk-cached library still paints without waiting for it.
  void initOfflineMode(epicGetOfflineMode).then(() => updateOfflineModeUi());
  // The clip recorder lives in Rust and reads its settings from there.
  pushClipSettings();
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
  void loadAmazonSession();
  void loadAmazonInstallDir();
  // The Accounts card hides the EGL session import when the launcher is gone:
  // importing from a missing launcher is how a session got lost before.
  void eglLauncherPresent()
    .then((present) => {
      if (S.eglLauncherPresent === present) return;
      S.eglLauncherPresent = present;
      if (S.view === "accounts") hooks.scheduleRender();
    })
    .catch(() => {});
  void hydrateSteamAuth();
  void loadSavedAccounts();
  void initCloudBackupSettings().then(() => {
    scheduleLocalBackups();
    scheduleProfileUploads();
  });

  if (isTauri) {
    void initEosInstall();
    void initAppUpdater();
    void invoke("app_set_decorations", { decorations: false }).catch(() => {});
    void invoke("app_set_minimize_to_tray", { enabled: S.minimizeToTray }).catch(() => {});
    void invoke("app_set_tray_labels", { show: t("tray.show"), overlay: t("overlay.overlayLabel"), quit: t("tray.quit") }).catch(() => {});
    void initPresence();
    // Non-Steam games started from their own client are caught by folder.
    syncInstalledWatch();
    window.setTimeout(syncInstalledWatch, 5_000);
    window.setInterval(syncInstalledWatch, 20_000);
    // Warm the Comet binary in the background so a GOG launch never waits for
    // the first download; the call is a no-op when the toggle is off.
    // Offline mode skips the Comet warm-up: it downloads the binary.
    if (!S.offlineMode) void epicPrepareComet().catch(() => {});
    void invoke<string>("library_dir")
      .then((p) => { S.libraryPath = p; })
      .catch(() => { S.libraryPath = t("common.unavailable"); });
    void epicListSkipped()
      .then((s) => { S.epicSkippedCount = s.length; })
      .catch(() => { S.epicSkippedCount = 0; });
    listenLater<SetupEvent>("legendary-setup", (event) => {
      S.setupProgress = event.payload.progress ?? null;
      S.setupMessage = localizeMessage(event.payload.message);
      if (event.payload.state === "error") toast(S.setupMessage, "err");
      if (S.view === "library") render();
    });
    listenLater<LibraryEvent>("legendary-library", (event) => {
      S.epicBusyMsg = localizeMessage(event.payload.message);
    });
    // Amazon installs stream their own progress lines; feed the same active
    // download metrics the Epic/GOG path uses, then patch the card in place.
    listenLater<NileProgressEvent>("nile-progress", (event) => {
      const { id, percent, speed, diskSpeed, eta, downloaded, total } = event.payload;
      const dl = S.downloads.get(id);
      // A late line after the install finished must not revive the card.
      if (!dl) return;
      const speedBytes = Math.round(speed * 1024 * 1024);
      const diskBytes = Math.round((diskSpeed ?? 0) * 1024 * 1024);
      const etaText = eta && eta !== "00:00:00" ? eta : t("common.calculating");
      S.amazonProgress.set(id, { percent, speed });
      dl.progress = percent;
      const title = dl.title || S.amazonGames.find((g) => amazonKey(g.id) === id)?.title || id;
      if (!S.activeDlMetrics || S.activeDlMetrics.id !== id) {
        S.peakNetSpeedBytes = 0;
        S.speedHistory.fill(0);
        S.diskHistory.fill(0);
        S.activeDlMetrics = {
          id,
          title,
          progress: percent,
          done: false,
          speed: `${speed.toFixed(2)} MiB/s`,
          speedBytes,
          diskSpeed: `${diskSpeed.toFixed(2)} MiB/s`,
          diskBytes,
          eta: etaText,
          downloadedBytes: downloaded,
          totalBytes: total,
        };
      } else {
        const m = S.activeDlMetrics;
        m.progress = percent;
        if (speedBytes > 0) {
          m.speed = `${speed.toFixed(2)} MiB/s`;
          m.speedBytes = speedBytes;
        }
        if (diskBytes > 0) {
          m.diskSpeed = `${diskSpeed.toFixed(2)} MiB/s`;
          m.diskBytes = diskBytes;
        }
        m.eta = etaText;
        m.downloadedBytes = downloaded;
        m.totalBytes = total;
      }
      startSpeedChartTimer();
      pushSpeedData(speedBytes, diskBytes);
      scheduleDlDomUpdate(id);
    });

    listenLater<DlProgressEvent>("download-progress", (event) => {
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
      // The Completed row shows what this transfer moved: an update downloads a
      // fraction of the install, so the folder size would be misleading.
      const movedBytes = S.activeDlMetrics?.id === id
        ? Math.max(S.activeDlMetrics.downloadedBytes, S.activeDlMetrics.totalBytes)
        : 0;
      pushRecentInstall(id, movedBytes);
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
    listenLater<{ id: string }>("download-paused", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = true;
      else S.dlQueueStatus.isPaused = true;
      lastDlSample = null;
      if (S.activeDlMetrics) {
        S.activeDlMetrics.speedBytes = 0;
        S.activeDlMetrics.diskBytes = 0;
      }
      if (S.view === "downloads") render();
    });
    listenLater<{ id: string }>("download-resumed", (event) => {
      if (event.payload.id.startsWith("gog::")) S.gogDlPaused = false;
      else S.dlQueueStatus.isPaused = false;
      if (S.view === "downloads") render();
    });
    listenLater<DownloadFailedEvent>("download-failed", (event) => {
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
    listenLater<DownloadCancelledEvent>("download-cancelled", (event) => {
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
    listenLater<VerifyProgressEvent>("verify-progress", (event) => {
      const { id, current, total, percent, speed, detail } = event.payload;
      // Nile reports verified/needed bytes. While nothing has been repaired yet
      // (the normal case) the bar would sit at 0%, so say what is happening.
      const shown = id.startsWith("amazon::") && total > 0
        ? current > 0
          ? `${fmtBytes(current)} / ${fmtBytes(total)}`
          : t("manage.verifying")
        : detail;
      updateVerifyProgressInPlace(id, current, total, percent, speed, shown);
    });
    listenLater<VerifyCompleteEvent>("verify-complete", (event) => {
      const { id, success, message } = event.payload;
      resetVerifyInPlace(id);
      if (success) {
        toast(t("verify.success"), "ok");
      } else {
        toast(t("verify.failed", { msg: localizeMessage(message) }), "err");
      }
    });

    listenLater<MoveGameProgress>("move-progress", (event) => {
      const payload = event.payload;
      if (!payload || !S.activeMoveModalAppName) return;
      if (payload.id === S.activeMoveModalAppName) {
        S.activeMoveProgress = payload;
        if (S.isMovingGame) {
          updateMoveProgressInPlace(payload);
        }
      }
    });
    listenLater<{ id?: string; success: boolean; newPath?: string; new_path?: string; message?: string }>(
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

    listenLater<{ appName?: string; title?: string; slug?: string }>(
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

    // A layered launch spends a few seconds creating its prefix; keep the
    // "Launching…" toast alive and show the elapsed time there.
    listenLater<{ appName: string; phase: string; elapsedSeconds: number }>(
      "compat-prefix-progress",
      (event) => {
        const { appName, phase, elapsedSeconds } = event.payload;
        if (phase === "starting" || phase === "running") {
          updateLaunchStatus(
            appName,
            t("compat.prefixPreparing", { seconds: elapsedSeconds }),
          );
        } else if (phase === "done" || phase === "error") {
          updateLaunchStatus(appName, t("dl.launching"));
        }
      },
    );

    listenLater<GameStatusEvent>("game-status", (event) => {
      const { id, running, initial, sessionSeconds, totalSeconds, sessionCount, lastPlayed, lastPlayedTimestamp } = event.payload;
      const sum = summaryOf(id);
      const title = sum?.title || id;
      const bootQuiet = Date.now() - GAME_WATCH_BOOT_AT < GAME_WATCH_BOOT_GRACE_MS;

      if (running) {
        // Every store and custom title gets its unlock watcher whether the
        // launcher, the store client or the running poll reported it. This sits
        // before the duplicate guard: later reports for the same session return
        // early.
        watchSteamAchievements(id);
        startStoreAchievementSession(id);
        // Two watchers can see the same game (Steam's flag and the process
        // watch); only the first report announces and acts.
        if (S.runningGames.has(id)) return;
        S.runningGames.add(id);
        clearLaunchStatus(id);
        // The backend needs every running title, not only a fresh start: a game
        // that opted out must stop the overlay for its whole session, and an
        // allowed one keeps the panel armed.
        void invoke("overlay_set_active_game", {
          appName: id,
          title,
          disabled: overlayDisabledFor(id),
        }).catch(() => {});
        // A game that was already open before the launcher booted is not a
        // fresh start: show its Running state, but do not toast, flash the
        // overlay, or minimize the window the user just opened.
        if (!initial && !bootQuiet) {
          // Point at the Shift+Tab overlay on the first start of the title, unless
          // the overlay is off globally or the user opted this game out.
          if (localStorage.getItem(OVERLAY_ENABLED_KEY) !== "false" && !overlayDisabledFor(id)) {
            void invoke("overlay_flash_hint", {
              title: t("overlay.enabledTitle", { key: overlayHotkeyLabel() }),
              body: t("overlay.startHint", { key: overlayHotkeyLabel() }),
            }).catch(() => {});
          }
          // Opt-in: get the launcher out of the way when a game starts. Full
          // Screen Mode is a couch UI and stays where it is.
          if (S.minimizeOnGame && !S.isFullscreen) {
            void appMinimize().catch(() => {});
          }
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
        // Recently played covers games started outside the launcher too.
        pushRecent(id);
        // The hero's state chip ("Online") is part of the meta line, which is
        // painted once: without this it would keep saying "Installed" while the
        // game is running.
        if (sum && S.currentModalAppName === id) paintGameMeta(sum);
        hooks.scheduleRender();
      } else {
        unwatchSteamAchievements(id);
        // The session may have unlocked achievements; refetch before the
        // duplicate-event guard, because a manual stop already cleared the flag
        // and its watcher event would otherwise return early.
        refreshAchievementsAfterSession(id, sessionSeconds);
        // A duplicate stop event must not toast or resume downloads twice.
        if (!S.runningGames.delete(id)) return;
        if (sum && S.currentModalAppName === id) paintGameMeta(sum);
        void invoke("overlay_clear_active_game", { appName: id }).catch(() => {});
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

    // The Media Studio scan decodes a thumbnail per capture; the page shows how
    // far along it is instead of an empty grid.
    listenLater<{ phase: string; done: number; total: number }>("media-scan-progress", (event) => {
      setMediaScanProgress(event.payload.phase, event.payload.done, event.payload.total);
    });

    listenLater<{ id: string; count: number }>("screenshots-updated", (event) => {
      const { id, count } = event.payload;
      if (count > 0) {
        if (ssNotifyOn()) toast(t("ss.newCaptures", { count }), "ok");
        const s = summaryOf(id);
        const title = s ? s.title : id;
        void fetchAndRenderScreenshots(id, title, true);
      }
    });

    listenLater<{ id: string; title: string }>(
      "screenshot-shutter",
      (event) => {
        if (ssSoundOn()) playScreenshotShutterSound();
        const sum = summaryOf(event.payload.id);
        const title = sum?.title || event.payload.title || "Oyun";
        if (ssNotifyOn()) toast(t("ss.capturingTitle", { title }), "ok");
      }
    );

    listenLater<{ id: string; title: string; item: GameScreenshotItem }>(
      "screenshot-captured",
      (event) => {
        const { id, item } = event.payload;
        if (ssNotifyOn()) toast(t("ss.saved", { file: item.file_name }), "ok");
        // The launcher window sits behind the game: a system toast is the only
        // feedback the player can actually see.
        void notifyBackgrounded(
          t("ss.notifyCapturedTitle"),
          t("ss.notifyCapturedBody", {
            game: summaryOf(id)?.title || event.payload.title || "",
            file: item.file_name,
          }),
        );

        const existing = S.loadedScreenshots.get(id) || [];
        S.loadedScreenshots.set(id, [item, ...existing.filter((x) => x.file_path !== item.file_path)]);

        if (S.currentModalAppName === id) {
          const badgeEl = modalRoot.querySelector('.drawer-tab[data-tab="screenshots"] .drawer-tab-badge');
          if (badgeEl) badgeEl.remove();

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

        // The page view (Settings → Screenshots) keeps its own list and listens
        // for this: without it a capture taken while the page is open is missing
        // until the user reloads.
        window.dispatchEvent(new CustomEvent("screenshots-changed"));

        if (S.screenshotCompressionEnabled) {
          // Compression is on by default now, so the automatic pass stays silent:
          // "capturing" + "saved" toasts are enough feedback for one hotkey press.
          void compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, true);
        }
      }
    );

    listenLater<{ appName: string; phase: string; uploaded: number; total: number }>("cloud-sync-progress", (event) => {
      const p = event.payload;
      S.cloudSyncProgress.set(p.appName, { phase: p.phase, uploaded: p.uploaded, total: p.total });
      updateManageSyncBar(p.appName);
    });

    listenLater<{ id: string; success: boolean; message?: string; syncedAt?: string }>("cloud-sync-complete", (event) => {
      const cloudSub = document.getElementById("manage-cloud-subtitle");
      const title = libraryItemOf(event.payload.id)?.title ?? S.epicSummariesMap.get(event.payload.id)?.title;
      // The transfer is over; the bar folds away and the row shows the result.
      S.cloudSyncProgress.delete(event.payload.id);
      updateManageSyncBar(event.payload.id);
      if (event.payload.success) {
        // The automatic run reports its own time so "Last synced" moves without
        // the manual button; an older payload falls back to now.
        const syncedAt = event.payload.syncedAt || String(Date.now());
        rememberCloudSync(event.payload.id, syncedAt);
        if (S.activeManageSettings && S.activeManageSettings.appName === event.payload.id) {
          S.activeManageSettings.lastCloudSync = syncedAt;
        }
        if (cloudSub) cloudSub.textContent = t("manage.lastSync", { time: formatSyncStamp(syncedAt) });
        // A successful upload is an event worth keeping; the toast alone vanishes.
        if (title && event.payload.success && S.cloudBackupSettings?.enabled && S.cloudBackupSettings.provider !== "none") {
          pushNotification({ kind: "info", title: t("notif.backupCloudDone", { title }), appName: event.payload.id });
        }
        return;
      }
      // A failed automatic cloud upload must not vanish while the game closes.
      const detail = localizeMessage(event.payload.message || "");
      toast(detail || t("backup.failed", { msg: "" }), "err");
      // A failed upload can be the path-MTU black hole; surface it once.
      void checkMtuAfterSyncFailure();
      if (title) pushNotification({ kind: "error", title: t("notif.cloudSyncFailed", { title }), body: detail, appName: event.payload.id });
    });

    // Discord: a message raises the sidebar count, and the overlay's own call
  // raises a dot; opening the page clears the count (like the real client).
  listenLater("discord-sdk-message", () => {
    noteDiscordMessage();
  });
  listenLater<{ state: string }>("discord-sdk-call", (event) => {
    setDiscordInCall(event.payload.state === "active");
  });
  // The embedded client's own calls (guild voice or a DM call) raise the same
  // dot: it is the primary way people are in voice.
  listenLater<{ inCall: boolean }>("discord-web-voice", (event) => {
    setDiscordInCall(event.payload.inCall);
  });

  listenLater("steam-library-changed", () => {
      void refreshSteamInstalled();
    });

  listenLater("custom-games-changed", () => {
    void loadCustomGamesLibrary();
  });

  listenLater<{
    appId: string;
    name: string;
    displayName: string;
    description: string;
    iconUrl: string;
    notification?: boolean;
    card?: boolean;
  }>("achievement-unlocked", (event) => {
    const { appId, name, displayName, description, notification = true, card = false } = event.payload;
    const isDirectKey =
      appId.includes("::") ||
      S.epicSummariesMap.has(appId) ||
      S.loadedAchievements.has(appId);
    const matchingCustomIds = S.customGames
      .filter((g) => g.steamAppId === appId)
      .map((g) => g.id);
    const fallbackRunningCustomIds =
      !isDirectKey && matchingCustomIds.length === 0
        ? [...S.runningGames].filter((k) => k.startsWith("custom::"))
        : [];
    const appKeys = isDirectKey
      ? [appId]
      : [
          `steam::${appId}`,
          ...matchingCustomIds,
          ...fallbackRunningCustomIds,
        ];
    // The watcher can fall back to the raw API name when no schema was
    // available; the cached list still knows the pretty label.
    const cachedItem = appKeys
      .map((key) => S.loadedAchievements.get(key)?.achievements.find((ach) => ach.name === name))
      .find((ach) => Boolean(ach));
    const label = displayName || cachedItem?.display_name || name;
    if (notification) {
      pushNotification({
        kind: "info",
        title: t("ach.unlockedNotification", { name: label }),
        body: description || cachedItem?.description || "",
        // The in-game card already announced it; the bell keeps the history.
        toast: !card,
      });
    }
    for (const key of appKeys) {
      const list = S.loadedAchievements.get(key);
      const entry = list?.achievements.find((ach) => ach.name === name);
      const wasUnlocked = entry?.unlocked === true;
      if (entry && !wasUnlocked) {
        entry.unlocked = true;
        entry.progress = 1;
        entry.unlock_date = new Date().toISOString().slice(0, 10);
      }
      const summary = S.epicAchSummaries[key];
      if (summary && !wasUnlocked) {
        summary.user_unlocked = (summary.user_unlocked || 0) + 1;
        patchLibraryCardDom(key);
      }
      if (S.currentModalAppName === key) {
        void fetchAndRenderAchievements(key, true);
      }
    }
  });

  // Game clips: the recorder runs in Rust; the UI only mirrors its state.
  listenLater<{ title: string }>("clip-started", (event) => {
    S.clipRecording = true;
    S.clipTitle = event.payload?.title ?? "";
    toast(t("ss.clipStarted", { title: S.clipTitle }), "ok");
    void notifyBackgrounded(t("ss.clipNotifyStartTitle"), t("ss.clipStarted", { title: S.clipTitle }));
    hooks.scheduleRender();
  });
  listenLater("clip-stopping", () => {
    toast(t("ss.clipStopping"), "");
  });
  listenLater<{ path: string; frames: number }>("clip-saved", (event) => {
    S.clipRecording = false;
    S.clipTitle = "";
    const name = event.payload?.path?.split(/[\\/]/).pop() ?? "";
    toast(t("ss.clipSaved", { file: name }), "ok");
    void notifyBackgrounded(t("ss.clipNotifySavedTitle"), t("ss.clipSaved", { file: name }));
    // The clips list on the screenshots page is loaded once; tell it to reload.
    window.dispatchEvent(new CustomEvent("screenshots-changed"));
    hooks.scheduleRender();
  });
  listenLater<string>("clip-error", (event) => {
    S.clipRecording = false;
    S.clipTitle = "";
    toast(localizeMessage(String(event.payload)), "err");
    hooks.scheduleRender();
  });

  // One parallel batch instead of 23 serial `listen` round trips (measured
  // ~900 ms of the boot path). Order never mattered; only that every listener
  // exists before the launcher is interactive.
  perfMark("boot:listeners-start");
  await Promise.all(bootListeners);
  perfMark("boot:listeners-done");

    // Playtimes only decorate the cards, so they load behind the first paint
    // instead of holding up the boot sequence.
    void epicGetPlaytimes()
      .then((pt) => {
        S.playtimeMap = new Map(Object.entries(pt));
        S.libraryDataRev++;
        if (S.view === "library" && S.showCoverStats) hooks.scheduleRender();
        // Epic's server snapshot fills in the hours played outside this launcher.
        void syncEpicServerPlaytimes();
      })
      .catch(() => undefined);
    // Independent boot reads; running them together removes serial IPC round trips.
    const [networkProfile, settings, autoShortcut, defaultDir, drives] = await Promise.all([
      epicGetNetworkProfile().catch(() => null),
      epicGetSettings().catch(() => null),
      epicGetAutoDesktopShortcut().catch(() => null),
      epicDefaultInstallDir().catch(() => ""),
      epicGetSystemDrives().catch(() => []),
    ]);
    if (networkProfile !== null) S.networkProfile = networkProfile ?? "";
    if (settings) {
      S.epicSettingsCache = settings;
      S.preferredCdn = settings.preferred_cdn ?? "";
    }
    if (defaultDir) S.epicDefaultDir = defaultDir;
    S.moveSystemDrives = Array.isArray(drives) ? drives : [];
    // The library can paint from the cached list before the drive list lands;
    // repaint the visible cards so the missing-drive badge appears.
    refreshLibraryResultsInPlace();
    if (autoShortcut !== null) S.autoDesktopShortcut = autoShortcut;

    // Other accounts' games come from disk snapshots (no network) so the shared
    // library is ready as soon as the shell paints.
    void loadSharedLibrary();

    // Steam games come from the Steam client's own manifests on this PC.
    void loadSteamLibrary().then(() => {
      perfMark("library:steam");
      startSteamLibraryWatch();
    });
    void loadCompanionLibrary().then(() => perfMark("library:companion"));
    void loadCustomGamesLibrary().then(() => perfMark("library:custom"));
    // Linked companion accounts refresh in the background (Ubisoft session).
    void syncCompanionAccounts();

    // The overlay settings tab persists these; Rust starts with defaults each run.
    if (localStorage.getItem(OVERLAY_ENABLED_KEY) === "false") {
      void invoke("overlay_set_enabled", { enabled: false }).catch(() => {});
    }
    if (localStorage.getItem(OVERLAY_HUD_KEY) === "true") {
      void invoke("overlay_set_hud", { enabled: true }).catch(() => {});
    }

    // Desktop shortcuts start the launcher with `--launch <app>`: hand it to the
    // same play path as the Play button once the shell is up.
    try {
      const pending = await epicTakePendingLaunch();
      if (pending) window.setTimeout(() => void epicPlay(pending), 1200);
    } catch {
      // ignore
    }
    // The pictures the game pages paint are warmed only when the window is idle:
    // the first version started this at boot, which is where it hurt.
    prefetchRecentPicturesWhenIdle();
    // Same idea for the text sources: HLTB, critic, store specs, IGDB and the
    // recent games' screenshots. The disk caches stay warm between runs, so the
    // next visit to a page paints from local data instead of asking again.
    prefetchGamePagesWhenIdle();
    // Covers the player can see get their real achievement progress without
    // opening each game page; the metadata-only rows would otherwise keep
    // showing a false zero.
    prefetchVisibleAchievements();
    // A card the pointer rests on is the next page most of the time; warm it
    // after a short pause so a sweep across the grid does not fire requests.
    initHoverPrefetch();
    // Everything the boot path must do before the launcher is fully usable has
    // been kicked off; this mark is the number to compare between releases.
    perfMark("boot:ready");
    // A marker left by a killed or crashed process means the last run did not
    // finish cleanly. Offer the feedback report automatically, after the shell
    // has painted so the dialog is usable immediately.
    window.setTimeout(() => {
      void feedbackRecoveryPending()
        .then((pending) => {
          if (pending) openFeedback();
        })
        .catch(() => undefined);
    }, 900);
  }
}
