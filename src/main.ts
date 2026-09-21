import "./styles/index.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LANGUAGES, applyStaticTranslations, setLanguage, t } from "./i18n";
import {
  CircleUserRound,
  Download,
  Gamepad2,
  LayoutGrid,
  Settings,
  Store,
  createIcons,
} from "lucide";
import {
  EPIC_LOGIN_URL,
  EPIC_STORE_URL,
  epicCachedLibrary,
  epicCancelDownload,
  epicDefaultInstallDir,
  epicEnsureBinary,
  epicAchievementsUrl,
  epicGetAchievements,
  epicGetAchievementsSummary,
  epicGetSystemRequirements,
  epicGetSettings,
  epicImportEgl,
  epicInstallGame,
  epicLaunchGame,
  epicListGames,
  epicListInstalled,
  epicListSkipped,
  epicLoginWithCode,
  epicLogout,
  epicPortrait,
  epicSetInstallDir,
  epicSetupStatus,
  epicStorePageUrl,
  epicStoreSearch,
  epicUninstallGame,
  getAntiCheat,
  getThirdPartyLauncher,
  isNotAuth,
  summarize,
  toEpicSlug,
  type CachedLibrary,
  type DownloadCancelledEvent,
  type DownloadFailedEvent,
  type EpicAchievementSummary,
  type EpicAchievementsData,
  type EpicAchievementItem,
  type EpicGame,
  epicDetectEglGames,
  epicSyncEglInstalled,
  epicThirdPartyLaunchers,
  type ThirdPartyLauncher,
  epicGetGameSettings,
  epicSaveGameSettings,
  epicVerifyGame,
  epicSyncSaves,
  epicCreateDesktopShortcut,
  epicPauseDownload,
  epicResumeDownload,
  epicReorderQueue,
  epicGetQueue,
  epicGetGameDlcs,
  epicGetInstallOptions,
  epicInstallWithOptions,
  epicCheckUpdates,
  epicGetPlaytimes,
  epicSetPlaytime,
  epicGetNetworkProfile,
  epicSetNetworkProfile,
  epicGetOfflineMode,
  epicSetOfflineMode,
  epicBackupSave,
  epicListBackups,
  epicRestoreBackup,
  epicDeleteBackup,
  epicOpenBackupFolder,
  epicGetCollections,
  epicSaveCollection,
  epicDeleteCollection,
  epicSetGameCollections,
  epicImportEglCollections,
  epicGetHltb,
  epicGetCritic,
  epicGetGameScreenshots,
  epicCaptureGameScreenshot,
  epicDeleteGameScreenshot,
  epicOpenGameScreenshotsFolder,
  epicSetScreenshotHotkey,
  epicGetScreenshotHotkey,
  epicReplaceScreenshotWithCompressed,
  type HltbData,
  type CriticData,
  type GoygoyReview,
  type GameScreenshotItem,
  type GameCollection,
  type PlaytimeRecord,
  type GameStatusEvent,
  type SaveBackupInfo,
  type GameDlcItem,
  type GameDlcResponse,
  type GameInstallOptions,
  type InstallOptionTag,
  type GameUpdateInfo,
  type DlProgressEvent,
  type DlQueueStatus,
  type GameLocalSettings,
  type VerifyProgressEvent,
  type VerifyCompleteEvent,
  type EglDetectedGame,
  type EpicSettings,
  type EpicSummary,
  type GameRequirementsResponse,
  type LibraryEvent,
  type SetupEvent,
  type SetupStatus,
  type SystemDetailItem,
  type SystemRequirement,
  type ThirdPartyLauncherInfo,
  epicGetSteamGridKey,
  epicSetSteamGridKey,
  epicTestSteamGridKey,
  epicSearchSteamGrid,
  epicGetSteamGridCovers,
  type SteamGridGame,
  type SteamGridImage,
  epicGetPlayerProfile,
  type EpicPlayerProfile,
  type ProfileGameRecord,
  epicGetSystemDrives,
  epicSelectFolderDialog,
  epicMoveGame,
  epicCancelMoveGame,
  type SystemDriveInfo,
  type MoveGameProgress,
  type MoveGameResult,
} from "./epic";
import { S } from "./core/state";
import {
  CUSTOM_COVERS_KEY,
  CUSTOM_HEROES_KEY,
  DEMO_PLAT_KEY,
  FALLBACK_META,
  FAV_KEY,
  INITIAL_CARD_CHUNK,
  LANG_KEY,
  META,
  MOCK_KEY,
  MORE_CARD_CHUNK,
  RECENT_KEY,
  SS_COMPRESS_KEY,
  SS_FORMAT_KEY,
  SS_HOTKEY_KEY,
  SS_HOTKEY_NAME_KEY,
  SS_QUALITY_KEY,
  fetchGames,
  isTauri,
  loadStrSet,
  metaOf,
  mockCatalog,
  mockInstalled,
  saveMockInstalled,
} from "./core/constants";
import {
  closeModal,
  collectionRoot,
  ctxRoot,
  dlBadge,
  manageRoot,
  modalRoot,
  moveModalRoot,
  playtimeRoot,
  selectiveRoot,
  viewEl,
} from "./core/dom";
import {
  epicActionButtons,
  epicArt,
  epicDlProgress,
  isAppPlatinum,
  toggleFav,
} from "./core/game-view";
import {
  gameById,
  installGame,
  launchGame,
  refreshGames,
  uninstallGame,
} from "./core/demo";
import {
  bootEpic,
  epicDoImport,
  epicDoLogin,
  epicDoLogout,
  epicDownload,
  loadEpicAchSummaries,
  refreshEpic,
  syncEpicLibrary,
} from "./features/auth/auth-actions";
import {
  epicCancel,
  epicInstall,
  epicPlay,
  epicUninstall,
  refreshEpicInstalled,
  refreshUpdates,
} from "./core/epic-actions";
import { updateBadge, updateChrome, updateNavIndicator, updateOfflineModeUi } from "./core/nav";
import { handleWindowResize, updateMaxIcon } from "./core/window";
import { pruneRecent, pushRecent } from "./core/recent";
import {
  registerCloseAllModals,
  registerGamepadHud,
  registerOpenEpicModal,
  registerRender,
} from "./core/render";
import { epicWideArt, isTurkishUser, rawOf, setEpicGamesRaw, setEpicSummaries, summaryOf } from "./core/selectors";
import { initContextMenu } from "./features/context-menu/context-menu";
import { renderDlcManager, renderDlcRows } from "./features/dlc/dlc-manager";
import {
  applySelectiveInstall,
  closeSelectiveModal,
  openSelectiveModal,
  renderSelectiveModal,
} from "./features/dlc/selective-install";
import {
  applyMovedGamePath,
  browseMoveTarget,
  cancelMoveGame,
  closeMoveGameModal,
  openMoveGameModal,
  startMoveGame,
} from "./features/move-game/move-game-actions";
import {
  renderMoveGameModalFrame,
  updateMoveProgressInPlace,
  updateMoveSpaceBadgeInPlace,
} from "./features/move-game/move-game-view";
import {
  closeCollectionModal,
  deleteCollectionFromModal,
  openCollectionModal,
  loadEpicCollections,
  openGameCollectionsModal,
  renderCollectionModal,
  saveCollectionFromModal,
  saveGameCollectionsFromModal,
  updateColGamesListInPlace,
  updateColPresetArrows,
  updateDrawerCollectionsBoxInPlace,
  updateEmojiUi,
} from "./features/collections/collections-view";
import "./features/events/click-router";
import "./features/events/input-listeners";
import {
  cycleTopView,
  gamepadLoop,
  handleGamepadDirectionalMove,
  handleGamepadTabSwitch,
  initGamepadSupport,
  updateGamepadHud,
} from "./features/gamepad/gamepad";
import {
  cleanSteamGridSearchTerm,
  closeCustomCoverModal,
  loadSteamGridCovers,
  openCustomCoverModal,
  renderCustomCoverModalContent,
  renderCustomCoverModalFrame,
  resetCustomCover,
  resetCustomHero,
  saveCustomCover,
  saveCustomHero,
  searchAndLoadSteamGrid,
} from "./features/cover/cover-view";
import {
  closeManageModal,
  openManageModal,
  renderManageModal,
  resetVerifyInPlace,
  updateManageModalInputsInPlace,
  updateVerifyProgressInPlace,
} from "./features/manage/manage-view";
import {
  closeEditPlaytimeModal,
  openEditPlaytimeModal,
  saveEditedPlaytime,
} from "./features/playtime/playtime-view";
import {
  hideStore,
  loadPlayerProfile,
  openProfile,
  openStore,
  openStoreUrl,
  renderStoreLoadingScreen,
  setView,
  storeRect,
  syncStoreViewSize,
} from "./features/store/store-view";
import {
  closeScreenshotLightbox,
  closeShareModal,
  compressImageToBlob,
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  fetchAndRenderScreenshots,
  navigateScreenshotLightbox,
  openScreenshotLightbox,
  openShareModal,
  playScreenshotShutterSound,
  renderDrawerScreenshots,
} from "./features/screenshots/screenshots-view";
import {
  enrichAchievementsData,
  ensureTabVisible,
  epicOpenFolder,
  fetchAndRenderAchievements,
  fetchAndRenderRequirements,
  openEpicModal,
  renderDrawerAchievements,
  renderDrawerDlcs,
  renderDrawerManage,
  renderDrawerOverview,
  renderDrawerSystemRequirements,
  updateCriticUI,
  updateDrawerTabArrows,
} from "./features/drawer/drawer-view";
import {
  cleanStoreDescription,
  detectControllerSupport,
  fmtTierName,
  getAchTier,
  getHardwareIcon,
  getHardwareLabel,
  isMacSys,
  isOnlineOnlyGame,
  isWinSys,
  renderAchievementCard,
  renderAchievementSections,
  renderBackupListHtml,
  renderCriticCard,
  renderGameFeatures,
  renderHltbCard,
  renderOverviewMediaSpotlight,
  renderOverviewTrophySpotlight,
} from "./features/drawer/drawer-widgets";
import {
  drawSpeedCanvas,
  pushSpeedData,
  renderDownloads,
  startSpeedChartTimer,
} from "./features/downloads/downloads-view";
import {
  epicCardPortrait,
  epicRowHtml,
  epicVisibleSummaries,
  renderEpic,
  renderEpicItems,
  resetCardChunk,
  setupLibScrollObserver,
  updateLibraryFilterInPlace,
} from "./features/library/library-view";
import { renderProfile, renderProfileGameCards } from "./features/profile/profile-view";
import { loadSettingsView, renderSettings } from "./features/settings/settings-view";
import { toast } from "./core/toast";
import { cleanDisplayVersion, esc, fmtAchDate, fmtBytes, fmtPlaytime, fmtPrice, fmtSize, formatScreenshotDate } from "./core/utils";
import { epicPlatinumIcon, icon, type IconName } from "./core/icons";
import type { CardSize, CatalogMeta, DrawerTab, EpicFilter, EpicPhase, EpicSort, EpicViewMode, Game, View } from "./core/types";

/* EN: Domain types live in `src/core/types.ts`. TR: Alan tipleri `src/core/types.ts` içindedir. */

/* ---------- Durum ---------- */



/** Mağaza dışına çıkıldığında geri dönülecek görünüm (tek durum makinesi). */

/** Native gömülü mağaza webview'i şu anda gerçekten gösteriliyor mu? */


/* ---------- Epic (Legendary) durumu ---------- */











/** İlk kurulum (onboarding) sihirbazı adımı: 1 Hoş Geldiniz, 2 Hesap Bağla, 3 Doğrulama. */



/* ---------- Epic kütüphane görünümü (filtre/sıralama/boyut) ---------- */




/* ---------- Özel Kapak ve Afiş (Custom Cover & Hero Art) ---------- */

try {
  S.customCovers = JSON.parse(localStorage.getItem(CUSTOM_COVERS_KEY) ?? "{}");
} catch {
  S.customCovers = {};
}


try {
  S.customHeroes = JSON.parse(localStorage.getItem(CUSTOM_HEROES_KEY) ?? "{}");
} catch {
  S.customHeroes = {};
}


/* ---------- HowLongToBeat Durumu ---------- */



/* ---------- Eleştirmen & İnceleme Skorları (OpenCritic / Metacritic) ---------- */



/* ---------- Dil & Yerelleştirme Ayarları ---------- */

/* ---------- Koleksiyonlar (Kategoriler) ---------- */

 // null = Tümü, "fav" = Favoriler, veya collection.id



/* ---------- Başarımlar Durumu ---------- */



/* ---------- Ekran Görüntüleri Durumu & Ayarları ---------- */

 // 123 = F12

 // DEFAULT: KAPALI!




















/* ---------- Oynama Süresi (Playtime Tracker) & Canlı Oyun Durumu ---------- */



/* ---------- Oyuncu Profili Durumu ---------- */







/* ---------- Çevrimdışı Mod, Ağ Profili & Yedekleme ---------- */









/* ---------- Gömülü mağaza (ana pencere içi webview) ---------- */







































/* ---------- Gelişmiş İndirme & Hız Durumu ---------- */







/* ---------- Yardımcılar ---------- */

/* ---------- Render ---------- */


/* ---------- Seçici Kurulum (Selective Install - Screenshot 3) ---------- */

/* ---------- Top bar: active tab underline ---------- */





function scheduleRender(): void {
  if (S.renderScheduled) return;
  S.renderScheduled = true;
  requestAnimationFrame(() => {
    S.renderScheduled = false;
    render();
  });
}

function render(): void {
  // Mağaza dışı bir görünüm çizilirken native webview'i kesin olarak gizle (üst üste binme yok).
  if (S.view !== "store" && S.storeShown) hideStore();
  document.querySelectorAll("#nav button").forEach((b) => {
    const el = b as HTMLElement;
    const active = S.view === "store"
      ? el.dataset.act === "open-store"
      : el.dataset.view === S.view;
    el.classList.toggle("active", active);
  });
  updateNavIndicator();
  if (S.view === "store") {
    viewEl.innerHTML = renderStoreLoadingScreen();
    updateChrome();
    return;
  }
  if (S.view !== "library" && modalRoot.innerHTML.trim()) {
    closeModal();
  }
  viewEl.innerHTML =
    S.view === "library" ? renderEpic()
    : S.view === "downloads" ? renderDownloads()
    : S.view === "dlc-manager" ? renderDlcManager()
    : S.view === "profile" ? renderProfile()
    : renderSettings();
  if (S.view === "library") {
    setupLibScrollObserver();
  }
  if (S.view === "downloads") {
    drawSpeedCanvas();
  }
  updateChrome();
  updateGamepadHud(S.gamepadPolling);
}

/* ---------- Epic (Legendary) ---------- */

function closeAllModals(): void {
  closeModal();
  closeScreenshotLightbox();
  closeShareModal();
  closeCustomCoverModal();
  closeCollectionModal();
  if (manageRoot) manageRoot.innerHTML = "";
  if (selectiveRoot) selectiveRoot.innerHTML = "";
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

/* ---------- Olaylar (delegation) ---------- */

async function init(): Promise<void> {
  updateMaxIcon();
  if (isTauri) {
    void invoke("app_set_decorations", { decorations: false }).catch(() => {});
  }
  createIcons({
    icons: { Store, LayoutGrid, Download, CircleUserRound, Settings, Gamepad2 },
  });
  // Seçili dili yükle, yönü (LTR/RTL) uygula ve statik üst bar metinlerini çevir.
  await setLanguage(S.appLanguage);
  applyStaticTranslations();
  updateOfflineModeUi();
  initContextMenu();
  registerRender(render, scheduleRender);
  registerGamepadHud(updateGamepadHud);
  registerOpenEpicModal(openEpicModal);
  registerCloseAllModals(closeAllModals);
  if (isTauri) {
    try {
      S.libraryPath = await invoke<string>("library_dir");
    } catch {
      S.libraryPath = "alınamadı";
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
      S.epicBusyMsg = event.payload.message;
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
            eta: eta ?? "Hesaplanıyor…",
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
      toast(`İndirme başarısız: ${event.payload.message}`, "err");
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads" || S.view === "library") render();
      });
    });
    await listen<DownloadCancelledEvent>("download-cancelled", (event) => {
      S.downloads.delete(event.payload.id);
      if (S.activeDlMetrics?.id === event.payload.id) S.activeDlMetrics = null;
      updateBadge();
      toast("İndirme iptal edildi", "");
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
        toast("Dosyalar başarıyla doğrulandı.", "ok");
      } else {
        toast(`Doğrulama hatası: ${message}`, "err");
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
          toast(`Taşıma işlemi tamamlanamadı: ${payload.message || "Hata"}`, "err");
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
        toast(`${title} çalışıyor…`, "ok");
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
        toast(`${title} kapandı ${sessionSeconds ? `(Oturum: ${fmtPlaytime(sessionSeconds)})` : ""}`, "");
      }

      // Butonları ve rozetleri güncelle
      document.querySelectorAll<HTMLElement>(`[data-id="${id}"]`).forEach((el) => {
        if (el.dataset.act === "epic-play") {
          if (running) {
            el.classList.add("running");
            el.innerHTML = `<span class="running-dot"></span> Oynanıyor…`;
          } else {
            el.classList.remove("running");
            el.innerHTML = `${icon("play", 14)} Oyna`;
          }
        }
      });

      if (S.view === "library") {
        render();
      }

      if (S.activeManageSettings?.appName === id) {
        renderManageModal();
      }
      if (S.currentModalAppName === id && S.activeDrawerTab === "overview") {
        openEpicModal(id, false);
      }
    });

    await listen<{ id: string; count: number }>("screenshots-updated", (event) => {
      const { id, count } = event.payload;
      if (count > 0) {
        toast(`${count} yeni ekran görüntüsü kaydedildi`, "ok");
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
        toast(`${title} — Ekran görüntüsü alınıyor…`, "ok");
      }
    );

    await listen<{ id: string; title: string; item: GameScreenshotItem }>(
      "screenshot-captured",
      (event) => {
        const { id, item } = event.payload;
        toast(`Ekran görüntüsü kaydedildi: ${item.file_name}`, "ok");

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
      toast("Bulut kayıtları eşitlendi (EOS)", "ok");
      const cloudSub = document.getElementById("manage-cloud-subtitle");
      if (cloudSub) cloudSub.textContent = "Bulut kayıtları güncel";
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

/* ---------- Game Controller (Gamepad / Kol) Desteği ---------- */




void init();
