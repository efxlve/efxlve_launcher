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
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum } from "./core/game-view";
import {
  epicCancel,
  epicInstall,
  epicPlay,
  epicUninstall,
  refreshEpicInstalled,
  refreshUpdates,
} from "./core/epic-actions";
import { updateBadge, updateChrome, updateNavIndicator } from "./core/nav";
import { pruneRecent, pushRecent } from "./core/recent";
import { registerGamepadHud, registerOpenEpicModal, registerRender } from "./core/render";
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
import { renderSettings } from "./features/settings/settings-view";
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





function updateOfflineModeUi(): void {
  const btn = document.getElementById("btn-offline-mode");
  if (!btn) return;
  btn.classList.toggle("offline", S.offlineMode);
  btn.classList.toggle("online", !S.offlineMode);
  const label = btn.querySelector<HTMLElement>(".net-label");
  if (label) label.textContent = S.offlineMode ? t("nav.offline") : t("nav.online");
  btn.title = S.offlineMode
    ? "Çevrimdışı Mod Aktif — Epic ağ istekleri durduruldu (Çevrimiçi olmak için tıklayın)"
    : "Çevrimiçi Mod Aktif — Epic ağına bağlı (Çevrimdışı moda geçmek için tıklayın)";
}





function toggleFav(appName: string, triggerBtn?: HTMLElement | null): void {
  const isNowFaved = !S.epicFav.has(appName);
  if (isNowFaved) S.epicFav.add(appName);
  else S.epicFav.delete(appName);
  localStorage.setItem(FAV_KEY, JSON.stringify([...S.epicFav]));
  render();

  if (triggerBtn) {
    triggerBtn.classList.toggle("faved", isNowFaved);
    triggerBtn.classList.add("heart-burst");
    setTimeout(() => triggerBtn.classList.remove("heart-burst"), 600);
  }

  if (S.currentModalAppName === appName) {
    const favBtn = modalRoot.querySelector(`button[data-act="epic-fav"][data-id="${appName}"]`) as HTMLElement | null;
    if (favBtn) {
      favBtn.classList.toggle("faved", isNowFaved);
      favBtn.classList.add("heart-burst");
      setTimeout(() => favBtn.classList.remove("heart-burst"), 600);
      if (favBtn.classList.contains("btn")) {
        favBtn.innerHTML = `${icon("heart", 14)} ${isNowFaved ? "Favorilerde" : "Favoriye Ekle"}`;
      }
    }
  }
}

/* ---------- Gömülü mağaza (ana pencere içi webview) ---------- */




function storeRect(): { x: number; y: number; width: number; height: number } {
  const titlebar = document.getElementById("titlebar");
  const top = titlebar ? titlebar.offsetHeight : 0;
  return {
    x: 0,
    y: top,
    width: window.innerWidth,
    height: Math.max(100, window.innerHeight - top),
  };
}

function syncStoreViewSize(): void {
  if (S.view !== "store" || !S.storeShown || !isTauri) return;
  invoke<void>("resize_store_view", storeRect()).catch(() => undefined);
}

function renderStoreLoadingScreen(): string {
  return `
    <div class="store-loading-screen">
      <div class="store-loading-canvas">
        <div class="store-loading-brand">
          <div class="store-loading-mark">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/>
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/>
              <path d="M2 7h20"/>
            </svg>
          </div>
          <div class="store-loading-logotype">
            <span class="store-loading-brand-main">EPIC GAMES STORE</span>
            <span class="store-loading-brand-sub">GÖMÜLÜ MAĞAZA</span>
          </div>
        </div>

        <div class="store-loading-track-wrap">
          <div class="store-loading-track">
            <div class="store-loading-laser"></div>
          </div>
        </div>

        <div class="store-loading-status-wrap">
          <span class="store-loading-status-text">Mağaza ve oturum başlatılıyor</span>
          <span class="store-loading-status-dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      </div>
    </div>
  `;
}

async function openStore(): Promise<void> {
  await openStoreUrl(EPIC_STORE_URL, "store");
}

async function openStoreUrl(url: string, mode: "store" | "profile"): Promise<void> {
  closeAllModals();
  if (S.view === "store" && S.storeShown && S.lastStoreUrl === url && S.storeMode === mode) return;
  S.lastStoreUrl = url;
  S.storeMode = mode;
  S.view = "store";
  // Mağaza açılırken modern ve şık yükleme animasyonunu göster
  viewEl.innerHTML = renderStoreLoadingScreen();
  render();
  try {
    await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false });
    S.storeShown = true;
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
    S.storeShown = false;
    S.view = S.lastNonStoreView;
    render();
    toast(String(e), "err");
  }
}

async function loadPlayerProfile(forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  S.profileLoading = true;
  S.profileError = "";
  render();
  try {
    S.playerProfileData = await epicGetPlayerProfile(forceRefresh);
  } catch (e) {
    S.profileError = String(e);
  } finally {
    S.profileLoading = false;
    render();
  }
}

async function openProfile(): Promise<void> {
  setView("profile");
  closeAllModals();
  if (!S.playerProfileData && !S.profileLoading) {
    void loadPlayerProfile();
  }
  render();
}

/** Gömülü mağaza webview'ini atomik olarak gizler; mağazada kalındıysa son mağaza dışı görünüme döner. */
function hideStore(): void {
  if (S.storeShown) {
    S.storeShown = false;
    if (isTauri) invoke<string>("hide_store_view").catch((e: unknown) => toast(String(e), "err"));
  }
  if (S.view === "store") S.view = S.lastNonStoreView;
}

/** Görünüm değişimlerinin tek giriş noktası: mağaza durumu her zaman atomik güncellenir. */
function setView(next: View): void {
  if (next !== "store") {
    hideStore();
    S.lastNonStoreView = next;
  }
  S.view = next;
}




































/* ---------- Gelişmiş İndirme & Hız Durumu ---------- */







/* ---------- Yardımcılar ---------- */

function gameById(id: string): Game | undefined {
  return S.games.find((g) => g.id === id);
}

/* ---------- Aksiyonlar ---------- */

async function refreshGames(): Promise<void> {
  try {
    S.games = await fetchGames();
  } catch (e) {
    toast(`Oyun listesi alınamadı: ${String(e)}`, "err");
  }
  render();
}

async function installGame(id: string): Promise<void> {
  const game = gameById(id);
  if (!game || game.installed || S.downloads.get(id)?.done === false) return;
  S.downloads.set(id, { progress: 0, done: false, title: game.title });
  updateBadge();
  render();

  try {
    if (isTauri) {
      const msg = await invoke<string>("install_game", { id });
      toast(msg, "ok");
    } else {
      for (let p = 5; p <= 100; p += 5) {
        await new Promise((r) => setTimeout(r, 90));
        S.downloads.set(id, { progress: p, done: false, title: game.title });
        if (S.view === "downloads" || S.view === "library") render();
        updateBadge();
      }
      S.downloads.set(id, { progress: 100, done: true, title: game.title });
      const set = mockInstalled();
      set.add(id);
      saveMockInstalled(set);
      toast(`${game.title} kuruldu`, "ok");
    }
  } catch (e) {
    S.downloads.delete(id);
    toast(`Kurulum başarısız: ${String(e)}`, "err");
  }
  await refreshGames();
}

async function launchGame(id: string): Promise<void> {
  try {
    if (isTauri) {
      const msg = await invoke<string>("launch_game", { id });
      toast(msg, "ok");
    } else {
      toast(`${gameById(id)?.title ?? id} başlatılıyor… (demo modu)`, "ok");
    }
  } catch (e) {
    toast(String(e), "err");
  }
}

async function uninstallGame(id: string): Promise<void> {
  try {
    if (isTauri) {
      const msg = await invoke<string>("uninstall_game", { id });
      toast(msg, "ok");
    } else {
      const set = mockInstalled();
      set.delete(id);
      saveMockInstalled(set);
      toast(`${gameById(id)?.title ?? id} kaldırıldı`, "ok");
    }
  } catch (e) {
    toast(String(e), "err");
  }
  closeModal();
  await refreshGames();
}

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

async function bootEpic(): Promise<void> {
  if (!isTauri || S.epicBooted) return;
  S.epicBooted = true;
  void epicGetSteamGridKey().then((k) => { S.steamGridApiKey = k; }).catch(() => {});
  if (S.screenshotHotkey && S.screenshotHotkey > 0) {
    void epicSetScreenshotHotkey(S.screenshotHotkey).catch(() => {});
  }
  await refreshEpic();
}

async function refreshEpic(): Promise<void> {
  if (!isTauri) {
    render();
    return;
  }
  S.epicPhase = "checking";
  S.epicError = "";
  S.epicBusyMsg = "";
  S.epicSyncNote = "";
  render();
  try {
    S.setupInfo = await epicSetupStatus();
    if (S.setupInfo.needsDownload) {
      S.epicPhase = "setup";
      render();
      return;
    }
    const cached: CachedLibrary = await epicCachedLibrary();
    S.epicSkippedCount = cached.skipped.length;
    if (!cached.account) {
      S.epicPhase = "login";
      render();
      return;
    }
    S.epicAccount = cached.account;
    setEpicSummaries(summarize(cached.games, cached.installed, cached.skipped));
    pruneRecent();
    setEpicGamesRaw(cached.games);
    S.epicPhase = "library";
    render();
    void loadEpicAchSummaries();
    void loadEpicCollections();
    void refreshUpdates();
    void syncEpicLibrary(false);
  } catch (e) {
    S.epicPhase = "error";
    S.epicError = String(e);
    render();
  }
}

async function loadEpicAchSummaries(): Promise<void> {
  if (!isTauri) return;
  try {
    S.epicAchSummaries = await epicGetAchievementsSummary();
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Başarım özetleri alınamadı:", e);
  }
}

/** Arka plan senkronu */
async function syncEpicLibrary(manual: boolean): Promise<void> {
  if (!isTauri || S.epicSyncing) return;
  S.epicSyncing = true;
  if (manual) {
    S.epicBusyMsg = "Kütüphane senkronize ediliyor…";
    if (S.view === "library") render();
  }
  try {
    const [egames, einstalled, eskipped] = await Promise.all([
      epicListGames(),
      epicListInstalled(),
      epicListSkipped(),
    ]);
    setEpicSummaries(summarize(egames, einstalled, eskipped));
    pruneRecent();
    setEpicGamesRaw(egames);
    S.epicSkippedCount = eskipped.length;
    S.epicSyncNote = "";
    S.epicBusyMsg = "";
    void loadEpicAchSummaries();
    void refreshUpdates();
    if (manual) {
      try {
        S.epicCollections = await epicImportEglCollections();
      } catch {
        void loadEpicCollections();
      }
      toast("Kütüphane ve koleksiyonlar güncellendi", "ok");
    } else {
      void loadEpicCollections();
    }
  } catch (e) {
    if (isNotAuth(e)) {
      S.epicPhase = "login";
    } else {
      S.epicSyncNote = "Çevrimdışı önbellek gösteriliyor — senkron başarısız oldu.";
    }
  } finally {
    S.epicSyncing = false;
    S.epicBusyMsg = "";
    if (S.view === "library") scheduleRender();
  }
}

async function epicDownload(): Promise<void> {
  if (S.epicBusy) return;
  S.epicBusy = "download";
  S.setupProgress = 0;
  render();
  try {
    await epicEnsureBinary();
    toast("legendary hazır", "ok");
    await refreshEpic();
  } catch (e) {
    toast(`İndirme başarısız: ${String(e)}`, "err");
  } finally {
    S.epicBusy = "";
    S.setupProgress = null;
    if (S.view === "library") render();
  }
}

async function epicDoLogin(code: string): Promise<void> {
  if (!code.trim() || S.epicBusy) return;
  S.epicBusy = "login";
  render();
  try {
    S.epicAccount = await epicLoginWithCode(code);
    S.onboardingStep = 1;
    toast(`${S.epicAccount} olarak giriş yapıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Giriş başarısız: ${String(e)}`, "err");
  } finally {
    S.epicBusy = "";
    if (S.view === "library") render();
  }
}

async function epicDoImport(): Promise<void> {
  if (S.epicBusy) return;
  S.epicBusy = "import";
  render();
  try {
    S.epicAccount = await epicImportEgl();
    S.onboardingStep = 1;
    toast(`${S.epicAccount} oturumu aktarıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Aktarma başarısız: ${String(e)}`, "err");
  } finally {
    S.epicBusy = "";
    if (S.view === "library") render();
  }
}

async function epicDoLogout(): Promise<void> {
  try {
    const msg = await epicLogout();
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
  S.epicAccount = "";
  setEpicSummaries([]);
  setEpicGamesRaw([]);
  S.epicSkippedCount = 0;
  await refreshEpic();
}



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

function applyMovedGamePath(appName: string, newPath: string): void {
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

function closeMoveGameModal(): void {
  if (S.isMovingGame) {
    toast("Taşıma işlemi devam ediyor, lütfen önce iptal edin!", "");
    return;
  }
  S.activeMoveModalAppName = null;
  S.activeMoveProgress = null;
  const root = moveModalRoot || document.getElementById("move-modal-root");
  if (root) root.innerHTML = "";
}


async function openMoveGameModal(appName: string): Promise<void> {
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

async function browseMoveTarget(): Promise<void> {
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

async function startMoveGame(appName: string): Promise<void> {
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

async function cancelMoveGame(appName: string): Promise<void> {
  try {
    await epicCancelMoveGame(appName);
    toast("Taşıma iptal ediliyor… Kaynak dosyalar güvende.", "");
  } catch (err) {
    toast(`İptal isteği gönderilemedi: ${String(err)}`, "err");
  }
}

/* ---------- Epic indirme ---------- */


async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, eglList, sgdbKey, thirdParty] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
        epicGetSteamGridKey().catch(() => null),
        epicThirdPartyLaunchers().catch(() => [] as ThirdPartyLauncher[]),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.eglDetectedList = eglList;
      S.steamGridApiKey = sgdbKey;
      S.thirdPartyLaunchers = thirdParty;
    } catch {
      // sessiz geç
    }
  }
  render();
}

/* ---------- Olaylar (delegation) ---------- */

document.addEventListener("click", (e) => {
  // Sıralama açılır menüsü dışına tıklanırsa kapat
  if (S.isSortDropdownOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".sort-dropdown-container")) {
      S.isSortDropdownOpen = false;
      const menu = document.getElementById("sort-dropdown-menu");
      if (menu) menu.classList.remove("show");
    }
  }

  // Koleksiyon açılır menüsü dışına tıklanırsa kapat
  if (S.isColDropdownOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".col-dropdown-container")) {
      S.isColDropdownOpen = false;
      const menu = document.getElementById("col-dropdown-menu");
      if (menu) menu.classList.remove("show");
    }
  }

  // Emoji paleti dışına tıklanırsa kapat
  if (S.isEmojiPaletteOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".col-emoji-picker-container")) {
      S.isEmojiPaletteOpen = false;
      const pal = document.getElementById("col-emoji-palette");
      if (pal) pal.classList.remove("open");
    }
  }

  // Modal içi oyun/koleksiyon seçimi
  const gameItem = (e.target as HTMLElement).closest<HTMLElement>(".col-game-item");
  if (gameItem) {
    const appName = gameItem.dataset.app;
    const colId = gameItem.dataset.colId;

    if (appName) {
      const nowChecked = !S.colModalSelectedApps.has(appName);
      if (nowChecked) S.colModalSelectedApps.add(appName);
      else S.colModalSelectedApps.delete(appName);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);

      const cntEl = document.getElementById("col-tab-selected-cnt") || document.getElementById("col-selected-count");
      if (cntEl) cntEl.textContent = String(S.colModalSelectedApps.size);

      const headerBadge = document.getElementById("col-header-selected-badge");
      if (headerBadge) headerBadge.textContent = `${S.colModalSelectedApps.size} Seçildi`;

      const footerCnt = document.getElementById("col-footer-count");
      if (footerCnt) footerCnt.textContent = String(S.colModalSelectedApps.size);

      if (S.colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
      return;
    } else if (colId) {
      const nowChecked = !S.gameColModalSelectedCols.has(colId);
      if (nowChecked) S.gameColModalSelectedCols.add(colId);
      else S.gameColModalSelectedCols.delete(colId);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);
      return;
    }
  }

  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-view]");
  if (!t) return;

  if (t.dataset.view) {
    closeAllModals();
    setView(t.dataset.view as View);
    if (S.view === "library") void bootEpic();
    if (S.view === "profile") {
      if (!S.playerProfileData && !S.profileLoading) void loadPlayerProfile();
      render();
      return;
    }
    if (S.view === "downloads") {
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        render();
      }).catch(() => render());
      return;
    }
    if (S.view === "settings") {
      void loadSettingsView();
      return;
    }
    render();
    return;
  }
  const act = t.dataset.act;
  const id = t.dataset.id;
  if (act === "install" && id) void installGame(id);
  else if (act === "play" && id) void launchGame(id);
  else if (act === "uninstall" && id) void uninstallGame(id);
  else if (act === "close") {
    const el = e.target as HTMLElement;
    if (el === t || t.matches(".hub-back-btn, .hub-tool-btn, .drawer-close, .mclose") || el.closest(".hub-back-btn, .hub-tool-btn, .drawer-close, .mclose")) closeModal();
  } else if (act === "goto-library") {
    closeAllModals();
    setView("library");
    render();
  } else if (act === "reset-demo") {
    localStorage.removeItem(MOCK_KEY);
    S.downloads.clear();
    updateBadge();
    toast("Demo verisi sıfırlandı", "ok");
    void refreshGames();
  } else if (act === "epic-download") {
    void epicDownload();
  } else if (act === "epic-open-login") {
    openUrl(EPIC_LOGIN_URL).catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "epic-do-login") {
    const input = document.getElementById("epic-code") as HTMLInputElement | null;
    void epicDoLogin(input?.value ?? "");
  } else if (act === "epic-import") {
    void epicDoImport();
  } else if (act === "onboarding-goto") {
    const step = parseInt(t.dataset.step || "1", 10);
    if (step >= 1 && step <= 3) {
      S.onboardingStep = step;
      render();
    }
  } else if (act === "epic-logout") {
    void epicDoLogout();
  } else if (act === "epic-refresh") {
    void syncEpicLibrary(true);
  } else if (act === "epic-retry") {
    void refreshEpic();
  } else if (act === "to-top") {
    viewEl.scrollTo({ top: 0, behavior: "smooth" });
  } else if (act === "open-store") {
    void openStore();
  } else if (act === "open-profile") {
    openProfile();
  } else if (act === "refresh-profile") {
    void loadPlayerProfile(true);
  } else if (act === "copy-account-id") {
    const val = t.dataset.val;
    if (val) {
      navigator.clipboard.writeText(val).then(() => {
        toast("Hesap ID panoya kopyalandı", "ok");
      }).catch(() => {
        toast(val, "");
      });
    }
  } else if (act === "profile-filter" && t.dataset.val) {
    S.profileFilter = t.dataset.val as typeof S.profileFilter;
    render();
  } else if (act === "profile-search-clear") {
    S.profileSearchQuery = "";
    render();
  } else if (act === "open-game-from-profile") {
    const appId = t.dataset.id || (t.closest("[data-id]") as HTMLElement)?.dataset.id;
    if (appId) {
      openEpicModal(appId, true);
    }
  } else if (act === "epic-filter" && t.dataset.val) {
    S.epicFilter = t.dataset.val as typeof S.epicFilter;
    if (!updateLibraryFilterInPlace()) render();
  } else if (act === "quick-tab" && t.dataset.tab) {
    const tab = t.dataset.tab;
    const hadCustomCol = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    if (tab === "all") {
      S.activeCollectionId = null;
      S.epicFilter = "all";
    } else if (tab === "installed") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "installed" ? "all" : "installed";
    } else if (tab === "fav") {
      S.activeCollectionId = "fav";
      S.epicFilter = "all";
    } else if (tab === "platinum") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "platinum" ? "all" : "platinum";
    } else if (tab === "updates") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "updates" ? "all" : "updates";
    }
    S.isColDropdownOpen = false;
    S.isSortDropdownOpen = false;
    const hasCustomCol = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    if (hadCustomCol !== hasCustomCol || !updateLibraryFilterInPlace()) {
      render();
    }
  } else if (act === "toggle-col-dropdown") {
    if (S.isSortDropdownOpen) {
      S.isSortDropdownOpen = false;
      const smenu = document.getElementById("sort-dropdown-menu");
      if (smenu) smenu.classList.remove("show");
    }
    S.isColDropdownOpen = !S.isColDropdownOpen;
    const menu = document.getElementById("col-dropdown-menu");
    if (menu) {
      menu.classList.toggle("show", S.isColDropdownOpen);
    } else {
      render();
    }
  } else if (act === "toggle-sort-dropdown") {
    if (S.isColDropdownOpen) {
      S.isColDropdownOpen = false;
      const cmenu = document.getElementById("col-dropdown-menu");
      if (cmenu) cmenu.classList.remove("show");
    }
    S.isSortDropdownOpen = !S.isSortDropdownOpen;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) {
      menu.classList.toggle("show", S.isSortDropdownOpen);
    } else {
      render();
    }
  } else if (act === "select-sort") {
    const sortVal = t.dataset.sort as EpicSort;
    S.isSortDropdownOpen = false;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) menu.classList.remove("show");
    if (sortVal && sortVal !== S.epicSort) {
      S.epicSort = sortVal;
      localStorage.setItem("efxlve-sort", S.epicSort);
      render();
    }
  } else if (act === "clear-collection") {
    S.activeCollectionId = null;
    S.isColDropdownOpen = false;
    S.isSortDropdownOpen = false;
    render();
  } else if (act === "toggle-hero-spotlight") {
    S.isHeroCollapsed = !S.isHeroCollapsed;
    localStorage.setItem("efxlve-hero-collapsed", S.isHeroCollapsed ? "1" : "0");
    render();
  } else if (act === "epic-size" && t.dataset.val) {
    S.epicCardSize = t.dataset.val as CardSize;
    localStorage.setItem("efxlve-card-size", S.epicCardSize);
    render();
  } else if (act === "epic-view-grid") {
    S.epicViewMode = "grid";
    localStorage.setItem("efxlve-view-mode", "grid");
    render();
  } else if (act === "epic-view-shelves") {
    S.epicViewMode = "shelves";
    localStorage.setItem("efxlve-view-mode", "shelves");
    render();
  } else if (act === "epic-view-list") {
    S.epicViewMode = "list";
    localStorage.setItem("efxlve-view-mode", "list");
    render();
  } else if (act === "shelf-scroll") {
    const dir = t.dataset.dir;
    const shelf = t.closest(".shelf-section");
    const track = shelf?.querySelector(".shelf-row-track");
    if (track) {
      track.scrollBy({ left: dir === "left" ? -420 : 420, behavior: "smooth" });
    }
  } else if (act === "open-custom-cover" && id) {
    const target = (t.dataset.target as "cover" | "hero") || "cover";
    openCustomCoverModal(id, target);
  } else if (act === "set-cover-target" && id) {
    const target = (t.dataset.target as "cover" | "hero") || "cover";
    if (target !== S.activeCoverTarget) {
      S.activeCoverTarget = target;
      S.sgdbAssetType = target === "hero" ? "heroes" : "grids";
      S.sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
      renderCustomCoverModalContent(id);
      if (S.customCoverActiveTab === "steamgrid" && S.sgdbSelectedGameId) {
        void loadSteamGridCovers(id, S.sgdbSelectedGameId);
      }
    }
  } else if (act === "cover-modal-backdrop") {
    if (e.target === t) closeCustomCoverModal();
  } else if (act === "prevent-modal-close") {
    // İçeriğe tıklandığında modal kapanmasın
  } else if (act === "close-custom-cover") {
    if (t.classList.contains("cover-overlay") && e.target !== t) return;
    closeCustomCoverModal();
  } else if (act === "toggle-sgdb-modal-info") {
    S.showModalSgdbInfo = !S.showModalSgdbInfo;
    if (S.activeCustomCoverAppName) {
      renderCustomCoverModalContent(S.activeCustomCoverAppName);
    }
  } else if ((act === "open-external-url" || act === "open-critic-url") && t.dataset.url) {
    void openUrl(t.dataset.url);
  } else if (act === "switch-cover-tab" && t.dataset.tab) {
    S.customCoverActiveTab = t.dataset.tab as typeof S.customCoverActiveTab;
    document.querySelectorAll(".cover-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === S.customCoverActiveTab);
    });
    if (S.activeCustomCoverAppName) {
      renderCustomCoverModalContent(S.activeCustomCoverAppName);
    }
  } else if (act === "sgdb-search" && id) {
    const input = document.getElementById("sgdb-search-input") as HTMLInputElement | null;
    if (input) S.sgdbSearchQuery = input.value;
    void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
  } else if (act === "sgdb-select-game" && id && t.dataset.gameId) {
    const gId = parseInt(t.dataset.gameId, 10);
    if (!isNaN(gId)) {
      S.sgdbSelectedGameId = gId;
      void loadSteamGridCovers(id, gId);
    }
  } else if (act === "sgdb-set-asset-type" && id && t.dataset.type) {
    const type = t.dataset.type as "grids" | "heroes";
    S.sgdbAssetType = type;
    const target = type === "heroes" ? "hero" : "cover";
    if (target !== S.activeCoverTarget) {
      S.activeCoverTarget = target;
      S.sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
    }
    if (S.sgdbSelectedGameId) {
      void loadSteamGridCovers(id, S.sgdbSelectedGameId);
    }
  } else if (act === "sgdb-set-style" && id) {
    S.sgdbActiveStyle = t.dataset.style || "";
    if (S.sgdbSelectedGameId) {
      void loadSteamGridCovers(id, S.sgdbSelectedGameId);
    }
  } else if (act === "sgdb-select-card" && t.dataset.url) {
    S.sgdbSelectedCoverUrl = t.dataset.url;
    document.querySelectorAll(".sgdb-card").forEach((card) => {
      const isSel = (card as HTMLElement).dataset.url === S.sgdbSelectedCoverUrl;
      card.classList.toggle("selected", isSel);
      const check = card.querySelector(".sgdb-selected-check");
      if (isSel && !check) {
        card.insertAdjacentHTML("beforeend", `<div class="sgdb-selected-check">${icon("check", 14)}</div>`);
      } else if (!isSel && check) {
        check.remove();
      }
    });
    const previewImg = document.getElementById("cover-preview-img") as HTMLImageElement | null;
    const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
    if (previewImg && previewImg.tagName === "IMG") {
      previewImg.src = S.sgdbSelectedCoverUrl;
    } else if (previewWrapper) {
      previewWrapper.innerHTML = `
        <img id="cover-preview-img" src="${esc(S.sgdbSelectedCoverUrl)}" alt="Önizleme" />
        <div class="cover-preview-badge">Seçilen Önizleme</div>
      `;
    }
    const badge = previewWrapper?.querySelector(".cover-preview-badge");
    if (badge) badge.textContent = "Seçilen Önizleme";
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    if (input) input.value = S.sgdbSelectedCoverUrl;
  } else if (act === "save-inline-sgdb-key" && id) {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    if (!key) {
      toast("Lütfen geçerli bir SteamGridDB API anahtarı girin", "err");
      return;
    }
    epicSetSteamGridKey(key)
      .then(() => {
        S.steamGridApiKey = key;
        toast("SteamGridDB API anahtarı kaydedildi", "ok");
        renderCustomCoverModalContent(id);
        void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "save-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    epicSetSteamGridKey(key)
      .then(() => {
        S.steamGridApiKey = key || null;
        toast(key ? "SteamGridDB API anahtarı kaydedildi" : "SteamGridDB API anahtarı kaldırıldı", "ok");
        render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "test-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || S.steamGridApiKey || "";
    if (!key) {
      toast("Lütfen test edilecek API anahtarını girin", "err");
      return;
    }
    toast("SteamGridDB bağlantısı test ediliyor…", "");
    epicTestSteamGridKey(key)
      .then(() => toast("SteamGridDB bağlantısı başarılı!", "ok"))
      .catch((err) => toast(`Bağlantı hatası: ${String(err)}`, "err"));
  } else if (act === "toggle-sgdb-key-visibility") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    if (input) {
      S.showSettingsSgdbKey = !S.showSettingsSgdbKey;
      input.type = S.showSettingsSgdbKey ? "text" : "password";
      t.innerHTML = icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "toggle-modal-sgdb-key-visibility") {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    if (input) {
      S.showModalSgdbKey = !S.showModalSgdbKey;
      input.type = S.showModalSgdbKey ? "text" : "password";
      t.innerHTML = icon(S.showModalSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "preview-custom-cover-url") {
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    const val = input?.value.trim();
    if (val) {
      S.sgdbSelectedCoverUrl = val;
      const previewImg = document.getElementById("cover-preview-img") as HTMLImageElement | null;
      const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
      if (previewImg && previewImg.tagName === "IMG") {
        previewImg.src = val;
      } else if (previewWrapper) {
        previewWrapper.innerHTML = `
          <img id="cover-preview-img" src="${esc(val)}" alt="Önizleme" />
          <div class="cover-preview-badge">Web Bağlantısı</div>
        `;
      }
      const badge = previewWrapper?.querySelector(".cover-preview-badge");
      if (badge) badge.textContent = "Web Bağlantısı";
    }
  } else if (act === "save-custom-cover" && id) {
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    const val = S.sgdbSelectedCoverUrl || input?.value.trim() || "";
    if (val) {
      if (S.activeCoverTarget === "hero") {
        saveCustomHero(id, val);
        toast("Özel yatay afiş (Hero) kaydedildi", "ok");
      } else {
        saveCustomCover(id, val);
        toast("Özel dikey kapak (2:3) kaydedildi", "ok");
      }
      closeCustomCoverModal();
    } else {
      toast("Lütfen SteamGridDB'den bir görsel seçin, URL girin veya dosya yükleyin", "err");
    }
  } else if (act === "reset-active-target" && id) {
    if (S.activeCoverTarget === "hero") {
      resetCustomHero(id);
      toast("Yatay afiş orijinal haline döndürüldü", "ok");
    } else {
      resetCustomCover(id);
      toast("Dikey kapak orijinal haline döndürüldü", "ok");
    }
    S.sgdbSelectedCoverUrl = "";
    renderCustomCoverModalFrame(id);
    renderCustomCoverModalContent(id);
  } else if (act === "reset-all-art" && id) {
    resetCustomCover(id);
    resetCustomHero(id);
    S.sgdbSelectedCoverUrl = "";
    toast("Tüm özel görseller orijinal haline döndürüldü", "ok");
    renderCustomCoverModalFrame(id);
    renderCustomCoverModalContent(id);
  } else if (act === "reset-custom-cover" && id) {
    resetCustomCover(id);
    closeCustomCoverModal();
    toast("Orijinal kapak görseline dönüldü", "ok");
  } else if (act === "epic-fav" && id) {
    toggleFav(id, t);
  } else if (act === "epic-detail" && id) {
    openEpicModal(id);
  } else if (act === "select-collection") {
    const colId = t.dataset.colId;
    if (colId === "all") {
      S.activeCollectionId = null;
      if (S.epicFilter === "fav") S.epicFilter = "all";
    } else if (colId === "fav") {
      S.activeCollectionId = "fav";
      S.epicFilter = "all";
    } else if (colId) {
      S.activeCollectionId = colId;
      if (S.epicFilter === "fav") S.epicFilter = "all";
    }
    S.isColDropdownOpen = false;
    if (S.currentModalAppName) closeModal();
    render();
  } else if (act === "open-new-collection-modal") {
    S.isColDropdownOpen = false;
    openCollectionModal();
  } else if (act === "edit-collection") {
    S.isColDropdownOpen = false;
    const colId = t.dataset.colId;
    if (colId) openCollectionModal(colId);
  } else if (act === "close-col-modal") {
    closeCollectionModal();
  } else if (act === "col-modal-backdrop") {
    if (e.target === t) closeCollectionModal();
  } else if (act === "toggle-col-emoji-palette") {
    S.isEmojiPaletteOpen = !S.isEmojiPaletteOpen;
    const pal = document.getElementById("col-emoji-palette");
    if (pal) pal.classList.toggle("open", S.isEmojiPaletteOpen);
  } else if (act === "pick-col-emoji") {
    const emoji = t.dataset.emoji;
    if (emoji) {
      S.colModalSelectedEmoji = emoji;
      S.isEmojiPaletteOpen = false;
      updateEmojiUi();
    }
  } else if (act === "clear-col-emoji") {
    S.colModalSelectedEmoji = "";
    S.isEmojiPaletteOpen = false;
    updateEmojiUi();
  } else if (act === "apply-custom-emoji") {
    const customInput = document.getElementById("col-custom-emoji-input") as HTMLInputElement | null;
    const val = customInput?.value.trim() || "";
    if (val) {
      S.colModalSelectedEmoji = val;
      S.isEmojiPaletteOpen = false;
      updateEmojiUi();
    }
  } else if (act === "quick-col-preset") {
    const presetEmoji = t.dataset.emoji;
    const presetName = t.dataset.name;
    if (presetEmoji) {
      S.colModalSelectedEmoji = presetEmoji;
      updateEmojiUi();
    }
    const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
    if (nameInput && presetName) {
      nameInput.value = presetName;
      nameInput.focus();
    }
  } else if (act === "col-presets-scroll") {
    const dir = t.dataset.dir;
    const container = document.getElementById("col-presets-scrollable");
    if (container) {
      container.scrollBy({ left: dir === "left" ? -240 : 240, behavior: "smooth" });
      setTimeout(updateColPresetArrows, 250);
    }
  } else if (act === "col-tab-filter") {
    const filter = t.dataset.filter as "all" | "selected" | "installed";
    if (filter) {
      S.colModalTabFilter = filter;
      document.querySelectorAll(".col-filter-tab").forEach((tab) => {
        tab.classList.toggle("active", (tab as HTMLElement).dataset.filter === filter);
      });
      updateColGamesListInPlace();
    }
  } else if (act === "col-search-clear") {
    S.colModalSearchQuery = "";
    const sInput = document.getElementById("col-search-input") as HTMLInputElement | null;
    if (sInput) {
      sInput.value = "";
      sInput.focus();
    }
    updateColGamesListInPlace();
  } else if (act === "col-toggle-game") {
    const app = t.dataset.app || (t.closest(".col-game-item") as HTMLElement)?.dataset.app;
    if (app) {
      if (S.colModalSelectedApps.has(app)) {
        S.colModalSelectedApps.delete(app);
      } else {
        S.colModalSelectedApps.add(app);
      }
      const itemEl = (t.classList.contains("col-game-item") ? t : t.closest(".col-game-item")) as HTMLElement | null;
      const isChecked = S.colModalSelectedApps.has(app);
      const cb = itemEl?.querySelector(".col-game-cb") as HTMLInputElement | null;
      if (cb) cb.checked = isChecked;
      if (itemEl) itemEl.classList.toggle("selected", isChecked);

      const selCountEl = document.getElementById("col-tab-selected-cnt");
      if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

      if (S.colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
    }
  } else if (act === "col-select-all") {
    const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
    let matches = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
    if (S.colModalTabFilter === "installed") {
      matches = matches.filter((s) => s.installed);
    }
    matches.forEach((s) => S.colModalSelectedApps.add(s.appName));
    updateColGamesListInPlace();
  } else if (act === "col-deselect-all") {
    if (S.colModalTabFilter === "all" && !S.colModalSearchQuery.trim()) {
      S.colModalSelectedApps.clear();
    } else {
      const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
      let matches = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
      if (S.colModalTabFilter === "installed") {
        matches = matches.filter((s) => s.installed);
      }
      matches.forEach((s) => S.colModalSelectedApps.delete(s.appName));
    }
    updateColGamesListInPlace();
  } else if (act === "col-save-btn") {
    void saveCollectionFromModal();
  } else if (act === "col-delete-btn") {
    const colId = t.dataset.colId;
    if (colId) void deleteCollectionFromModal(colId);
  } else if (act === "manage-game-collections" && id) {
    openGameCollectionsModal(id);
  } else if (act === "save-game-col-btn") {
    void saveGameCollectionsFromModal();
  } else if (act === "import-egl-collections") {
    toast("Epic Games Launcher kütüphanesi taranıyor...", "");
    void epicImportEglCollections()
      .then((cols) => {
        toast(`${cols.length} koleksiyon başarıyla içe aktarıldı`, "ok");
        void loadEpicCollections();
        if (S.view === "settings") void loadSettingsView();
      })
      .catch((err) => {
        toast(`İçe aktarma hatası: ${String(err)}`, "err");
      });
  } else if (act === "epic-play" && id) {
    void epicPlay(id);
  } else if (act === "epic-install" && id) {
    void openSelectiveModal(id);
  } else if (act === "epic-cancel" && id) {
    void epicCancel(id);
  } else if (act === "epic-uninstall" && id) {
    void epicUninstall(id);
  } else if (act === "open-dlc-manager" && id) {
    S.activeDrawerTab = "dlcs";
    if (!S.dlcCache.has(id) && !S.dlcLoading) {
      S.dlcLoading = true;
      epicGetGameDlcs(id)
        .then((res) => {
          S.dlcCache.set(id, res);
          if (S.activeDrawerTab === "dlcs" && S.currentModalAppName === id) {
            openEpicModal(id, false);
          }
        })
        .catch(() => {})
        .finally(() => {
          S.dlcLoading = false;
          if (S.activeDrawerTab === "dlcs" && S.currentModalAppName === id) {
            openEpicModal(id, false);
          }
        });
    }
    openEpicModal(id, false);
  } else if (act === "dlc-back") {
    setView("library");
    render();
  } else if (act === "dlc-discover-store" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    void openStoreUrl(epicStorePageUrl(title), "store");
  } else if (act === "selective-close") {
    closeSelectiveModal();
  } else if (act === "selective-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeSelectiveModal();
  } else if (act === "open-edit-playtime" && id) {
    openEditPlaytimeModal(id);
  } else if (act === "close-edit-playtime") {
    closeEditPlaytimeModal();
  } else if (act === "playtime-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeEditPlaytimeModal();
  } else if (act === "pt-quick-add") {
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
  } else if (act === "pt-reset") {
    const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
    const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
    const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
    if (hInput) hInput.value = "0";
    if (mInput) mInput.value = "0";
    if (lpSelect) lpSelect.value = "";
  } else if (act === "save-playtime" && id) {
    void saveEditedPlaytime(id);
  } else if (act === "selective-apply" && id) {
    const tags = Array.from(S.selectedInstallTags);
    const dlcs = Array.from(S.selectedDlcAppIds);
    void applySelectiveInstall(id, tags, dlcs);
  } else if (act === "epic-save-install-dir") {
    const input = document.getElementById("epic-install-dir") as HTMLInputElement | null;
    const v = input?.value?.trim() ?? "";
    epicSetInstallDir(v ? v : null)
      .then((st: EpicSettings) => {
        S.epicSettingsCache = st;
        toast("Kurulum klasörü kaydedildi", "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "dl-save-install-dir") {
    const input = document.getElementById("dl-install-dir") as HTMLInputElement | null;
    const v = input?.value?.trim() ?? "";
    epicSetInstallDir(v ? v : null)
      .then((st: EpicSettings) => {
        S.epicSettingsCache = st;
        toast("Kurulum klasörü kaydedildi", "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "dl-pick-install-dir") {
    void (async () => {
      const input = document.getElementById("dl-install-dir") as HTMLInputElement | null;
      const current = input?.value?.trim() || S.epicDefaultDir || null;
      const chosen = await epicSelectFolderDialog(current).catch(() => null);
      if (!chosen) return;
      if (input) input.value = chosen;
      try {
        const st = await epicSetInstallDir(chosen);
        S.epicSettingsCache = st;
        toast("Kurulum klasörü kaydedildi", "ok");
        render();
      } catch (e) {
        toast(String(e), "err");
      }
    })();
  } else if (act === "epic-sync-egl") {
    if (S.eglSyncing) return;
    S.eglSyncing = true;
    render();
    epicSyncEglInstalled()
      .then(async (synced) => {
        await refreshEpicInstalled();
        S.eglDetectedList = await epicDetectEglGames().catch(() => []);
        toast(synced > 0 ? `${synced} oyun eşitlendi ve kütüphaneye eklendi!` : "Tüm oyunlar zaten eşitlenmiş durumda.", "ok");
      })
      .catch((e: unknown) => toast(`Eşitleme hatası: ${String(e)}`, "err"))
      .finally(() => {
        S.eglSyncing = false;
        render();
      });
  } else if (act === "epic-refresh-egl") {
    void loadSettingsView();
  } else if (act === "third-party-refresh") {
    epicThirdPartyLaunchers()
      .then((list) => {
        S.thirdPartyLaunchers = list;
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "manage-game" && id) {
    S.activeDrawerTab = "manage";
    openEpicModal(id, false);
  } else if (act === "open-move-game-modal" && id) {
    void openMoveGameModal(id);
  } else if (act === "close-move-modal") {
    closeMoveGameModal();
  } else if (act === "move-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t && !S.isMovingGame) closeMoveGameModal();
  } else if (act === "select-move-drive") {
    const drv = t.dataset.drive;
    if (drv && !S.isMovingGame) {
      S.selectedMoveDriveLetter = drv.toUpperCase();
      const curPath = S.selectedMoveTargetPath.replace(/^[a-zA-Z]:[\\/]/, "");
      S.selectedMoveTargetPath = `${S.selectedMoveDriveLetter}:\\${curPath || "Games"}`;
      renderMoveGameModalFrame();
    }
  } else if (act === "browse-move-target") {
    void browseMoveTarget();
  } else if (act === "start-move-game" && id) {
    void startMoveGame(id);
  } else if (act === "cancel-move-game" && id) {
    void cancelMoveGame(id);
  } else if (act === "manage-close") {
    closeManageModal();
  } else if (act === "manage-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeManageModal();
  } else if (act === "manage-verify" && id) {
    updateVerifyProgressInPlace(id, 0, 100, 0, "Başlatılıyor…", "Başlatılıyor…");
    epicVerifyGame(id).catch((err) => {
      resetVerifyInPlace(id);
      toast(`Doğrulama başlatılamadı: ${String(err)}`, "err");
    });
  } else if (act === "manage-sync-saves" && id && !S.manageSyncingSaves) {
    S.manageSyncingSaves = true;
    const syncBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-sync-saves"]');
    const cloudSub = document.getElementById("manage-cloud-subtitle");
    if (syncBtn) syncBtn.disabled = true;
    if (cloudSub) cloudSub.textContent = "Bulut ile eşitleniyor…";
    epicSyncSaves(id)
      .then((msg) => {
        toast(msg, "ok");
        const now = new Date().toLocaleString("tr-TR");
        if (S.activeManageSettings && S.activeManageSettings.appName === id) {
          S.activeManageSettings.lastCloudSync = now;
        }
        if (cloudSub) cloudSub.textContent = `En son eşitleme: ${now}`;
      })
      .catch((err) => {
        toast(`Bulut eşitleme hatası: ${String(err)}`, "err");
        if (cloudSub && S.activeManageSettings) {
          cloudSub.textContent = S.activeManageSettings.lastCloudSync
            ? `En son eşitleme: ${esc(S.activeManageSettings.lastCloudSync)}`
            : "Oyun ilerlemelerini Epic Online Services (EOS) bulutuna kaydet";
        }
      })
      .finally(() => {
        S.manageSyncingSaves = false;
        if (syncBtn) syncBtn.disabled = false;
      });
  } else if (act === "manage-create-shortcut" && id) {
    epicCreateDesktopShortcut(id)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(`Kısayol oluşturulamadı: ${String(err)}`, "err"));
  } else if (act === "manage-create-backup" && id && !S.isBackingUp) {
    S.isBackingUp = true;
    const createBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Yedekleniyor…"; }
    toast("Kayıtlar yerel olarak yedekleniyor…", "");
    epicBackupSave(id)
      .then((b) => {
        toast(`Yedek alındı: ${fmtBytes(b.size_bytes)} (${b.file_count} dosya)`, "ok");
        const cur = S.gameBackupsMap.get(id) || [];
        S.gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
        const listEl = document.getElementById("manage-backup-list");
        if (listEl) listEl.innerHTML = renderBackupListHtml(id);
      })
      .catch((err) => toast(`Yedekleme hatası: ${String(err)}`, "err"))
      .finally(() => {
        S.isBackingUp = false;
        const btnAfter = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
        if (btnAfter) { btnAfter.disabled = false; btnAfter.textContent = "Yedek Al"; }
      });
  } else if (act === "manage-restore-backup" && id) {
    const bid = t.dataset.bid;
    if (bid) {
      toast("Yedek geri yükleniyor…", "");
      epicRestoreBackup(id, bid)
        .then((msg) => toast(msg, "ok"))
        .catch((err) => toast(`Geri yükleme hatası: ${String(err)}`, "err"));
    }
  } else if (act === "manage-delete-backup" && id) {
    const bid = t.dataset.bid;
    if (bid) {
      epicDeleteBackup(id, bid)
        .then(() => {
          toast("Yedek silindi", "");
          const cur = S.gameBackupsMap.get(id) || [];
          S.gameBackupsMap.set(id, cur.filter((x) => x.id !== bid));
          const listEl = document.getElementById("manage-backup-list");
          if (listEl) listEl.innerHTML = renderBackupListHtml(id);
        })
        .catch((err) => toast(`Silme hatası: ${String(err)}`, "err"));
    }
  } else if (act === "manage-open-backup-folder" && id) {
    epicOpenBackupFolder(id)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "toggle-offline-mode") {
    S.offlineMode = !S.offlineMode;
    updateOfflineModeUi();
    void epicSetOfflineMode(S.offlineMode);
    toast(S.offlineMode ? "Çevrimdışı moda geçildi" : "Çevrimiçi moda geçildi", "ok");
    render();
  } else if (act === "set-net-profile") {
    const prof = t.dataset.profile;
    if (prof) {
      S.networkProfile = prof;
      void epicSetNetworkProfile(prof);
      const label = prof === "max" ? "Maksimum Hız (16 Worker)" : prof === "low" ? "Düşük Tüketim (1 Worker)" : "Dengeli (4 Worker)";
      toast(`İndirme profili: ${label}`, "ok");
      render();
    }
  } else if (act === "set-app-language") {
    const lang = t.dataset.lang;
    if (lang && lang !== S.appLanguage) {
      S.appLanguage = lang;
      localStorage.setItem(LANG_KEY, lang);
      void setLanguage(lang).then(() => {
        updateOfflineModeUi();
        toast(lang === "tr" ? "Dil Türkçe olarak ayarlandı" : "Language updated", "ok");
        render();
      });
    }
  } else if (act === "manage-save-args" && id && S.activeManageSettings) {
    const input = document.getElementById("manage-args-input") as HTMLInputElement | null;
    const val = input?.value?.trim() ?? "";
    S.activeManageSettings.launchParameters = val;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast("Başlatma parametreleri kaydedildi", "ok"))
      .catch((err) => toast(`Kayıt hatası: ${String(err)}`, "err"));
  } else if (act === "dl-pause" && id) {
    epicPauseDownload(id)
      .then((msg) => {
        S.dlQueueStatus.isPaused = true;
        toast(msg, "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-resume" && id) {
    epicResumeDownload(id)
      .then((msg) => {
        S.dlQueueStatus.isPaused = false;
        toast(msg, "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-up" && id) {
    epicReorderQueue(id, "up")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-down" && id) {
    epicReorderQueue(id, "down")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-now" && id) {
    epicReorderQueue(id, "now")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-remove" && id) {
    epicReorderQueue(id, "remove")
      .then((q) => {
        S.dlQueueStatus = q;
        toast("Kuyruktan kaldırıldı", "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "epic-open-folder" && id) {
    void epicOpenFolder(id);
  } else if (act === "epic-store-page" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    void openStoreUrl(epicStorePageUrl(title), "store");
  } else if (act === "drawer-tab") {
    const tab = t.dataset.tab as DrawerTab;
    if (tab && S.currentModalAppName) {
      if (tab === S.activeDrawerTab) return;
      S.activeDrawerTab = tab;
      if (tab === "achievements") {
        const cached = S.loadedAchievements.get(S.currentModalAppName);
        if (!cached || cached.achievements.length === 0) {
          void fetchAndRenderAchievements(S.currentModalAppName, true);
        }
      } else if (tab === "dlcs") {
        if (!S.dlcCache.has(S.currentModalAppName) && !S.dlcLoading) {
          S.dlcLoading = true;
          epicGetGameDlcs(S.currentModalAppName)
            .then((res) => {
              S.dlcCache.set(S.currentModalAppName!, res);
              if (S.activeDrawerTab === "dlcs" && S.currentModalAppName) {
                openEpicModal(S.currentModalAppName, false, true);
              }
            })
            .catch(() => {})
            .finally(() => {
              S.dlcLoading = false;
              if (S.activeDrawerTab === "dlcs" && S.currentModalAppName) {
                openEpicModal(S.currentModalAppName, false, true);
              }
            });
        }
      } else if (tab === "manage") {
        if (!S.gameBackupsMap.has(S.currentModalAppName)) {
          epicListBackups(S.currentModalAppName)
            .then((b) => {
              S.gameBackupsMap.set(S.currentModalAppName!, b);
              const listEl = document.getElementById("manage-backup-list");
              if (listEl && S.currentModalAppName) {
                listEl.innerHTML = renderBackupListHtml(S.currentModalAppName);
              }
            })
            .catch(() => {});
        }
      } else if (tab === "screenshots") {
        if (!S.loadedScreenshots.has(S.currentModalAppName)) {
          const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
          if (s) void fetchAndRenderScreenshots(S.currentModalAppName, s.title);
        }
      } else if (tab === "specs") {
        if (!S.loadedRequirements.has(S.currentModalAppName)) {
          const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
          if (s) void fetchAndRenderRequirements(S.currentModalAppName, s.title);
        }
      }
      openEpicModal(S.currentModalAppName, false, true);
    }
  } else if (act === "drawer-tabs-scroll") {
    const dir = t.dataset.dir;
    const container = document.getElementById("drawer-tabs-scrollable");
    if (container) {
      container.scrollBy({ left: dir === "left" ? -140 : 140, behavior: "smooth" });
      setTimeout(updateDrawerTabArrows, 180);
      setTimeout(updateDrawerTabArrows, 360);
    }
  } else if (act === "sys-plat") {
    const val = t.dataset.val;
    if (val && S.currentModalAppName) {
      if (S.activeSystemPlatform === val) return;
      S.activeSystemPlatform = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "req-refresh" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    if (s) void fetchAndRenderRequirements(id, s.title, true);
  } else if (act === "open-store-achievements" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    const url = epicAchievementsUrl(title, id);
    void openStoreUrl(url, "store");
  } else if (act === "clear-ach-search") {
    S.achSearchQuery = "";
    if (S.currentModalAppName) {
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-filter") {
    const val = t.dataset.val as "all" | "unlocked" | "locked" | "hidden";
    if (val && S.currentModalAppName) {
      if (S.activeAchFilter === val) return;
      S.activeAchFilter = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-scope") {
    const val = t.dataset.val as "all" | "base" | "dlc";
    if (val && S.currentModalAppName) {
      if (S.activeAchScope === val) return;
      S.activeAchScope = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-reveal") {
    const achName = t.dataset.ach;
    if (achName && S.currentModalAppName) {
      const key = `${S.currentModalAppName}:${achName}`;
      if (S.revealedAchievements.has(key)) {
        S.revealedAchievements.delete(key);
      } else {
        S.revealedAchievements.add(key);
      }
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "toggle-demo-platinum" && id) {
    if (S.demoPlatinumApps.has(id)) {
      S.demoPlatinumApps.delete(id);
      toast("Platin efekti kaldırıldı", "");
    } else {
      S.demoPlatinumApps.add(id);
      toast("Platin Kupa parıltısı açıldı!", "ok");
    }
    localStorage.setItem(DEMO_PLAT_KEY, JSON.stringify([...S.demoPlatinumApps]));
    if (S.view === "library") render();
    if (S.currentModalAppName === id) openEpicModal(id, false, false);
  } else if (act === "ach-refresh" && id) {
    void fetchAndRenderAchievements(id, true);
  } else if (act === "capture-screenshot" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = t.dataset.title || (s ? s.title : id);
    playScreenshotShutterSound();
    toast("Ekran görüntüsü alınıyor…", "");
    epicCaptureGameScreenshot(id, title)
      .then((item) => {
        toast(`Ekran görüntüsü kaydedildi: ${item.file_name}`, "ok");
        void fetchAndRenderScreenshots(id, title, true);
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "open-screenshots-folder" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = t.dataset.title || (s ? s.title : id);
    void epicOpenGameScreenshotsFolder(id, title);
  } else if (act === "delete-screenshot" && id) {
    const filePath = t.dataset.path;
    const isLightbox = t.dataset.lightbox === "true";
    if (filePath) {
      if (confirm("Bu ekran görüntüsünü silmek istediğinize emin misiniz?")) {
        epicDeleteGameScreenshot(filePath)
          .then((success) => {
            if (success) {
              toast("Ekran görüntüsü silindi", "ok");
              const s = S.epicSummaries.find((x) => x.appName === id);
              const title = s ? s.title : id;
              if (isLightbox) closeScreenshotLightbox();
              void fetchAndRenderScreenshots(id, title, true);
            } else {
              toast("Ekran görüntüsü silinemedi", "err");
            }
          })
          .catch((err) => toast(String(err), "err"));
      }
    }
  } else if (act === "open-screenshot-lightbox" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    openScreenshotLightbox(id, idx);
  } else if (act === "close-screenshot-lightbox") {
    closeScreenshotLightbox();
  } else if (act === "close-screenshot-lightbox-backdrop") {
    if (e.target === t) {
      closeScreenshotLightbox();
    }
  } else if (act === "lightbox-nav") {
    const dir = (t.dataset.dir as "prev" | "next") || "next";
    navigateScreenshotLightbox(dir);
  } else if (act === "share-screenshot" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    const list = S.loadedScreenshots.get(id) || [];
    const item = list[idx];
    if (item) {
      openShareModal(id, item);
    }
  } else if (act === "close-share-modal") {
    closeShareModal();
  } else if (act === "do-copy-image") {
    if (S.activeShareScreenshot) {
      void copyScreenshotImageToClipboard(S.activeShareScreenshot.item);
      closeShareModal();
    }
  } else if (act === "do-copy-path") {
    if (S.activeShareScreenshot) {
      const path = S.activeShareScreenshot.item.file_path;
      navigator.clipboard.writeText(path).then(() => {
        toast("Dosya yolu panoya kopyalandı.", "ok");
      }).catch(() => {
        toast(path, "");
      });
      closeShareModal();
    }
  } else if (act === "do-open-folder") {
    if (S.activeShareScreenshot) {
      const s = S.epicSummaries.find((x) => x.appName === S.activeShareScreenshot?.appName);
      const title = s ? s.title : S.activeShareScreenshot.appName;
      void epicOpenGameScreenshotsFolder(S.activeShareScreenshot.appName, title);
      closeShareModal();
    }
  } else if (act === "do-compress-from-share") {
    if (S.activeShareScreenshot) {
      const { appName, item } = S.activeShareScreenshot;
      closeShareModal();
      void compressScreenshotItem(appName, item);
    }
  } else if (act === "do-native-share") {
    if (S.activeShareScreenshot && typeof navigator.share === "function") {
      const item = S.activeShareScreenshot.item;
      navigator.share({
        title: item.file_name,
        text: `Oyun Ekran Görüntüsü: ${item.file_name}`,
      }).catch(() => {});
      closeShareModal();
    }
  } else if (act === "compress-screenshot" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    const list = S.loadedScreenshots.get(id) || [];
    const item = list[idx];
    if (item) {
      void compressScreenshotItem(id, item);
    }
  } else if (act === "compress-all-screenshots" && id) {
    const list = S.loadedScreenshots.get(id) || [];
    const uncompressed = list.filter((x) => !x.file_name.endsWith(".avif") && !x.file_name.endsWith(".webp"));
    if (uncompressed.length === 0) {
      toast("Tüm ekran görüntüleri zaten sıkıştırılmış", "ok");
    } else {
      toast(`⚡ ${uncompressed.length} ekran görüntüsü sıkıştırılıyor…`, "");
      (async () => {
        let count = 0;
        for (const item of uncompressed) {
          const res = await compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, true);
          if (res) count++;
        }
        toast(`✅ ${count} ekran görüntüsü ${S.screenshotCompressionFormat.toUpperCase()} formatına sıkıştırıldı!`, "ok");
      })();
    }
  } else if (act === "toggle-screenshot-compression") {
    S.screenshotCompressionEnabled = !S.screenshotCompressionEnabled;
    localStorage.setItem(SS_COMPRESS_KEY, String(S.screenshotCompressionEnabled));
    toast(S.screenshotCompressionEnabled ? "Görsel sıkıştırma etkinleştirildi" : "Görsel sıkıştırma kapatıldı (Ham PNG)", "ok");
    render();
  } else if (act === "set-ss-format" && t.dataset.format) {
    const fmt = t.dataset.format as "avif" | "webp" | "jpg";
    S.screenshotCompressionFormat = fmt;
    localStorage.setItem(SS_FORMAT_KEY, fmt);
    toast(`Sıkıştırma formatı: ${fmt.toUpperCase()}`, "ok");
    render();
  } else if (act === "record-screenshot-hotkey") {
    S.isRecordingScreenshotHotkey = !S.isRecordingScreenshotHotkey;
    if (S.isRecordingScreenshotHotkey) {
      toast("Klavyeden istediğiniz tuşa basın…", "");
    }
    render();
  } else if (act === "win-minimize") {
    if (isTauri) void invoke("app_minimize");
  } else if (act === "win-maximize") {
    if (isTauri) {
      void invoke<boolean>("app_toggle_maximize").then((isMax) => {
        updateMaxIcon(isMax);
        handleWindowResize();
        window.setTimeout(handleWindowResize, 100);
        window.setTimeout(handleWindowResize, 250);
        window.setTimeout(handleWindowResize, 500);
      });
    }
  } else if (act === "win-close") {
    if (isTauri) void invoke("app_close");
  }
});

// Yatay kaydırılabilir sekmeler için fare tekerleği desteği
document.addEventListener("wheel", (e) => {
  const scrollableBar = (e.target as HTMLElement)?.closest(".drawer-tabs, .drawer-tabs-wrapper, .ach-scope-segment, .col-quick-presets, .col-presets-track-wrapper") as HTMLElement | null;
  const targetBar = scrollableBar?.classList.contains("drawer-tabs-wrapper")
    ? (scrollableBar.querySelector(".drawer-tabs") as HTMLElement | null)
    : scrollableBar?.classList.contains("col-presets-track-wrapper")
      ? (scrollableBar.querySelector(".col-quick-presets") as HTMLElement | null)
      : scrollableBar;
  if (targetBar && e.deltaY !== 0 && targetBar.scrollWidth > targetBar.clientWidth) {
    e.preventDefault();
    targetBar.scrollLeft += e.deltaY;
    if (targetBar.id === "col-presets-scrollable") {
      updateColPresetArrows();
    } else {
      updateDrawerTabArrows();
    }
  }
}, { passive: false });

window.addEventListener("resize", () => {
  updateDrawerTabArrows();
  updateColPresetArrows();
});

document.addEventListener("keydown", (e) => {
  if (S.isRecordingScreenshotHotkey) {
    e.preventDefault();
    e.stopPropagation();
    const code = e.keyCode || e.which;
    if (code && code > 0) {
      const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      S.screenshotHotkey = code;
      S.screenshotHotkeyName = keyName;
      localStorage.setItem(SS_HOTKEY_KEY, String(code));
      localStorage.setItem(SS_HOTKEY_NAME_KEY, keyName);
      if (isTauri) void epicSetScreenshotHotkey(code);
      S.isRecordingScreenshotHotkey = false;
      toast(`Kısayol tuşu atandı: ${keyName} (${code})`, "ok");
      render();
    }
    return;
  }

  if (S.activeShareScreenshot) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeShareModal();
      return;
    }
  }

  if (S.activeLightboxScreenshot) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeScreenshotLightbox();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateScreenshotLightbox("prev");
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateScreenshotLightbox("next");
      return;
    }
  }

  if (e.keyCode === S.screenshotHotkey || e.key === S.screenshotHotkeyName || (S.screenshotHotkey === 0x7B && e.key === "F12")) {
    if (S.currentModalAppName) {
      e.preventDefault();
      const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
      const title = s ? s.title : S.currentModalAppName;
      toast("Ekran görüntüsü alınıyor…", "");
      epicCaptureGameScreenshot(S.currentModalAppName, title)
        .then((item) => {
          toast(`Ekran görüntüsü kaydedildi: ${item.file_name}`, "ok");
          playScreenshotShutterSound();
          void fetchAndRenderScreenshots(S.currentModalAppName!, title, true);
        })
        .catch((err) => toast(String(err), "err"));
      return;
    }
  }

  if (e.key === "Enter" || e.key === " ") {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.classList.contains("pcard") || active.classList.contains("screenshot-card")) && !active.closest("input, select, textarea")) {
      e.preventDefault();
      active.click();
      return;
    }
  }
  if (e.key === "Escape") {
    if (S.activeMoveModalAppName) {
      if (S.isMovingGame) {
        toast("Taşıma işlemi devam ediyor, lütfen önce iptal edin!", "");
      } else {
        closeMoveGameModal();
      }
      return;
    }
    const coverRoot = document.getElementById("cover-modal-root");
    if (coverRoot && coverRoot.innerHTML.trim()) {
      closeCustomCoverModal();
      return;
    }
    if (collectionRoot && collectionRoot.innerHTML.trim()) {
      closeCollectionModal();
      return;
    }
    if (playtimeRoot && playtimeRoot.innerHTML.trim()) {
      closeEditPlaytimeModal();
      return;
    }
    if (S.selectiveInstallOptions) {
      closeSelectiveModal();
      return;
    }
    if (manageRoot && manageRoot.innerHTML.trim()) {
      closeManageModal();
      return;
    }
    closeModal();
  }
  if (e.key === "Enter") {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && activeEl.id === "sgdb-search-input" && S.activeCustomCoverAppName) {
      e.preventDefault();
      searchAndLoadSteamGrid(S.activeCustomCoverAppName);
      return;
    }
    if (activeEl && activeEl.id === "modal-sgdb-key-input" && S.activeCustomCoverAppName) {
      e.preventDefault();
      const key = (activeEl as HTMLInputElement).value.trim();
      if (!key) {
        toast("Lütfen geçerli bir SteamGridDB API anahtarı girin", "err");
        return;
      }
      epicSetSteamGridKey(key)
        .then(() => {
          S.steamGridApiKey = key;
          toast("SteamGridDB API anahtarı kaydedildi", "ok");
          renderCustomCoverModalContent(S.activeCustomCoverAppName);
          void searchAndLoadSteamGrid(S.activeCustomCoverAppName, S.sgdbSearchQuery);
        })
        .catch((err) => toast(String(err), "err"));
      return;
    }
    if (activeEl && activeEl.id === "custom-cover-url-input") {
      e.preventDefault();
      const val = (activeEl as HTMLInputElement).value.trim();
      if (val) {
        S.sgdbSelectedCoverUrl = val;
        const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
        if (previewWrapper) {
          previewWrapper.innerHTML = `
            <img id="cover-preview-img" src="${esc(val)}" alt="Önizleme" />
            <div class="cover-preview-badge">Önizleme</div>
          `;
        }
      }
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    const s = document.getElementById("search");
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
});

document.addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (target && target.id === "custom-cover-file-input" && target.files && target.files[0]) {
    const file = target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      S.sgdbSelectedCoverUrl = result;
      const urlInput = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
      const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
      if (urlInput) urlInput.value = result;
      if (previewWrapper) {
        previewWrapper.innerHTML = `
          <img id="cover-preview-img" src="${result}" alt="Önizleme" />
          <div class="cover-preview-badge">Yerel Dosya</div>
        `;
      }
    };
    reader.readAsDataURL(file);
  }
  if (target && (target as HTMLElement).id === "ach-sort-select") {
    S.achSortOrder = (target as unknown as HTMLSelectElement).value as any;
    if (S.currentModalAppName) {
      openEpicModal(S.currentModalAppName, false, false);
    }
    return;
  }
  if (target && target.id === "ss-hotkey-select") {
    const code = parseInt(target.value, 10);
    if (code && code > 0) {
      S.screenshotHotkey = code;
      const found = S.PRESET_HOTKEYS.find((k) => k.code === code);
      const name = found ? found.name.split(" ")[0] : `Key_${code}`;
      S.screenshotHotkeyName = name;
      localStorage.setItem(SS_HOTKEY_KEY, String(code));
      localStorage.setItem(SS_HOTKEY_NAME_KEY, name);
      if (isTauri) void epicSetScreenshotHotkey(code);
      toast(`Kısayol tuşu güncellendi: ${name}`, "ok");
      render();
    }
    return;
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t && t.id === "ss-quality-slider") {
    const val = parseFloat((t as HTMLInputElement).value);
    S.screenshotCompressionQuality = val;
    localStorage.setItem(SS_QUALITY_KEY, String(val));
    const label = document.getElementById("ss-quality-val");
    if (label) label.textContent = `%${Math.round(val * 100)}`;
    return;
  }
  if (t.id === "ach-search-input" && S.currentModalAppName) {
    S.achSearchQuery = (t as HTMLInputElement).value;
    const container = document.getElementById("ach-list-container");
    if (container) {
      const data = S.loadedAchievements.get(S.currentModalAppName);
      const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
      if (data && s) {
        enrichAchievementsData(s.appName, data);
        const query = S.achSearchQuery.trim().toLowerCase();
        const isDemo = S.demoPlatinumApps.has(s.appName);
        const filteredItems = data.achievements.filter((a) => {
          const isUnlocked = a.unlocked || isDemo;
          if (S.activeAchFilter === "unlocked" && !isUnlocked) return false;
          if (S.activeAchFilter === "locked" && isUnlocked) return false;
          if (S.activeAchFilter === "hidden" && !a.hidden) return false;
          if (query) {
            const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
            const matchDesc = (a.description || "").toLowerCase().includes(query);
            if (!matchTitle && !matchDesc) return false;
          }
          return true;
        });
        const sortedItems = [...filteredItems].sort((a, b) => {
          if (S.achSortOrder === "rarity") {
            const ra = a.rarity?.percent ?? 100;
            const rb = b.rarity?.percent ?? 100;
            return ra - rb;
          }
          if (S.achSortOrder === "xp") return b.xp - a.xp;
          if (S.achSortOrder === "date") {
            const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
            const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
            return db - da;
          }
          return 0;
        });
        const hasDlc = data.achievements.some((a) => !a.is_base);
        container.innerHTML = renderAchievementSections(sortedItems, s, hasDlc, data.achievements);
      }
    }
    return;
  }
  if (t.id === "pt-hours-input" || t.id === "pt-minutes-input") {
    const h = parseInt((document.getElementById("pt-hours-input") as HTMLInputElement)?.value || "0", 10) || 0;
    const m = parseInt((document.getElementById("pt-minutes-input") as HTMLInputElement)?.value || "0", 10) || 0;
    const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
    if (lpSelect) {
      if (h > 0 || m > 0) {
        if (!lpSelect.value) {
          lpSelect.value = "Daha önce oynandı (Epic Games)";
        }
      } else {
        if (lpSelect.value === "Daha önce oynandı (Epic Games)") {
          lpSelect.value = "";
        }
      }
    }
    return;
  }
  if (t.id === "sgdb-search-input") {
    S.sgdbSearchQuery = (t as HTMLInputElement).value;
    return;
  }
  if (t.id === "search") {
    const val = (t as HTMLInputElement).value;
    if (S.libSearchTimer !== null) {
      window.clearTimeout(S.libSearchTimer);
    }
    S.libSearchTimer = window.setTimeout(() => {
      S.libSearchTimer = null;
      S.query = val;
      resetCardChunk();
      const box = document.getElementById("lib-results");
      if (box) {
        box.innerHTML = renderEpicItems();
        setupLibScrollObserver();
      }
    }, 120);
    return;
  }
  if (t.id === "dlc-search") {
    S.dlcSearchQuery = (t as HTMLInputElement).value;
    const bodyEl = document.getElementById("dlc-table-body");
    if (bodyEl && S.activeDlcAppName) {
      const dlcRes = S.dlcCache.get(S.activeDlcAppName);
      const allDlcs = dlcRes?.dlcs || [];
      const q = S.dlcSearchQuery.trim().toLowerCase();
      const filtered = q
        ? allDlcs.filter((d) => d.title.toLowerCase().includes(q))
        : allDlcs;
      bodyEl.innerHTML = renderDlcRows(filtered);
    }
    return;
  }
  if (t.id === "dlc-drawer-search" && S.currentModalAppName) {
    S.dlcSearchQuery = (t as HTMLInputElement).value;
    const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
    const contentEl = document.getElementById("drawer-tab-content");
    if (s && contentEl && S.activeDrawerTab === "dlcs") {
      contentEl.innerHTML = renderDrawerDlcs(s);
      const searchInput = document.getElementById("dlc-drawer-search") as HTMLInputElement | null;
      if (searchInput) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }
    }
    return;
  }
  if (t.id === "profile-search") {
    S.profileSearchQuery = (t as HTMLInputElement).value;
    const grid = document.getElementById("profile-games-grid");
    if (grid && S.playerProfileData) {
      const all = S.playerProfileData.games || [];
      let filtered = all.filter((g) => {
        if (S.profileFilter === "platinum") return g.is_platinum || g.unlocked_percent >= 100;
        if (S.profileFilter === "in_progress") return g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum;
        if (S.profileFilter === "not_started") return g.unlocked_percent === 0;
        return true;
      });
      if (S.profileSearchQuery.trim()) {
        const q = S.profileSearchQuery.trim().toLowerCase();
        filtered = filtered.filter(
          (g) => g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q),
        );
      }
      filtered.sort((a, b) => {
        if (S.profileSort === "progress") {
          return b.is_platinum !== a.is_platinum
            ? (b.is_platinum ? 1 : -1)
            : b.unlocked_percent !== a.unlocked_percent
              ? b.unlocked_percent - a.unlocked_percent
              : b.total_xp - a.total_xp;
        }
        if (S.profileSort === "xp") return b.total_xp - a.total_xp;
        if (S.profileSort === "playtime") {
          const ptA = S.playtimeMap.get(a.app_name)?.total_seconds || 0;
          const ptB = S.playtimeMap.get(b.app_name)?.total_seconds || 0;
          return ptB - ptA;
        }
        if (S.profileSort === "alpha") return a.app_title.localeCompare(b.app_title, "tr");
        return 0;
      });
      grid.innerHTML = renderProfileGameCards(filtered);
    }
    return;
  }
  if (t.id === "move-target-input") {
    const val = (t as HTMLInputElement).value;
    S.selectedMoveTargetPath = val;
    const trimmed = val.trim();
    if (trimmed.length >= 2 && trimmed[1] === ":") {
      const letter = trimmed[0].toUpperCase();
      if (letter !== S.selectedMoveDriveLetter.toUpperCase()) {
        S.selectedMoveDriveLetter = letter;
        const cards = document.querySelectorAll(".move-drive-card");
        cards.forEach((c) => {
          const el = c as HTMLElement;
          if (el.dataset.drive?.toUpperCase() === letter) {
            el.classList.add("selected");
          } else {
            el.classList.remove("selected");
          }
        });
      }
    }
    updateMoveSpaceBadgeInPlace();
    return;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "profile-sort-select") {
    S.profileSort = (t as HTMLSelectElement).value as typeof S.profileSort;
    render();
    return;
  }
  if (t.id === "epic-sort") {
    S.epicSort = (t as HTMLSelectElement).value as typeof S.epicSort;
    render();
    return;
  }
  const act = t.dataset.act;
  if (act === "manage-toggle-autoupdate" && S.activeManageSettings) {
    S.activeManageSettings.autoUpdate = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(S.activeManageSettings?.autoUpdate ? "Otomatik güncelleme açıldı" : "Otomatik güncelleme kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-priority" && S.activeManageSettings) {
    S.activeManageSettings.highPriority = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(S.activeManageSettings?.highPriority ? "Öncelikli indirme açıldı" : "Öncelikli indirme kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-cloud" && S.activeManageSettings) {
    S.activeManageSettings.cloudSavesEnabled = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(S.activeManageSettings?.cloudSavesEnabled ? "Bulut kayıtları açıldı" : "Bulut kayıtları kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-args-panel") {
    S.manageShowArgs = (t as HTMLInputElement).checked;
    const container = document.getElementById("manage-args-container");
    if (container) {
      container.style.display = S.manageShowArgs ? "" : "none";
      if (S.manageShowArgs) {
        const inp = document.getElementById("manage-args-input") as HTMLInputElement | null;
        inp?.focus();
      }
    }
  } else if (act === "selective-toggle-tag") {
    const tag = t.dataset.tag;
    if (tag) {
      if ((t as HTMLInputElement).checked) {
        S.selectedInstallTags.add(tag);
      } else {
        S.selectedInstallTags.delete(tag);
      }
      renderSelectiveModal();
    }
  } else if (act === "selective-toggle-dlc") {
    const dlc = t.dataset.dlc;
    if (dlc) {
      if ((t as HTMLInputElement).checked) {
        S.selectedDlcAppIds.add(dlc);
      } else {
        S.selectedDlcAppIds.delete(dlc);
      }
      renderSelectiveModal();
    }
  } else if (act === "dlc-toggle-install") {
    const app = t.dataset.app;
    const dlcId = t.dataset.dlc;
    const isChecked = (t as HTMLInputElement).checked;
    if (app && dlcId) {
      if (isChecked) {
        toast("Eklenti kuruluyor…", "");
        epicInstallGame(dlcId)
          .then(() => {
            toast("Eklenti indirme kuyruğuna eklendi", "ok");
            const cached = S.dlcCache.get(app);
            if (cached) {
              const item = cached.dlcs.find((d) => d.appId === dlcId);
              if (item) item.installed = true;
            }
          })
          .catch((err) => {
            (t as HTMLInputElement).checked = false;
            toast(`Eklenti kurulum hatası: ${String(err)}`, "err");
          });
      } else {
        toast("Eklenti kaldırılıyor…", "");
        epicUninstallGame(dlcId)
          .then(() => {
            toast("Eklenti kaldırıldı", "ok");
            const cached = S.dlcCache.get(app);
            if (cached) {
              const item = cached.dlcs.find((d) => d.appId === dlcId);
              if (item) item.installed = false;
            }
          })
          .catch((err) => {
            (t as HTMLInputElement).checked = true;
            toast(`Eklenti kaldırılamadı: ${String(err)}`, "err");
          });
      }
    }
  }
});

viewEl.addEventListener("scroll", () => {
  const totop = document.getElementById("totop");
  if (totop) totop.classList.toggle("show", viewEl.scrollTop > 600);
}, { passive: true });

function updateMaxIcon(isMax?: boolean): void {
  const iconEl = document.getElementById("win-max-icon");
  if (!iconEl) return;
  const setIcon = (max: boolean) => {
    if (max) {
      iconEl.innerHTML = `<rect width="7" height="7" x="2.5" y="0.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M0.5 2.5v7h7v-7h-7z" fill="none" stroke="currentColor" stroke-width="1"/>`;
    } else {
      iconEl.innerHTML = `<rect width="9" height="9" x="0.5" y="0.5" fill="none" stroke="currentColor" stroke-width="1"/>`;
    }
  };
  if (typeof isMax === "boolean") {
    setIcon(isMax);
  } else if (isTauri) {
    invoke<boolean>("app_is_maximized").then(setIcon).catch(() => {});
  }
}

function handleWindowResize(): void {
  updateMaxIcon();
  updateNavIndicator();
  if (typeof updateDrawerTabArrows === "function") {
    updateDrawerTabArrows();
  }
  if (typeof updateColPresetArrows === "function") {
    updateColPresetArrows();
  }
  if (S.view === "downloads" && typeof drawSpeedCanvas === "function") {
    drawSpeedCanvas();
  }
  if (S.view === "store") {
    syncStoreViewSize();
    window.clearTimeout(S.storeResizeTimer);
    S.storeResizeTimer = window.setTimeout(() => {
      syncStoreViewSize();
      window.setTimeout(syncStoreViewSize, 80);
      window.setTimeout(syncStoreViewSize, 200);
      window.setTimeout(syncStoreViewSize, 450);
    }, 40);
  }
}

document.getElementById("titlebar")?.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("#nav button, .win-btn, input, a")) return;
  if (isTauri) {
    void invoke<boolean>("app_toggle_maximize").then((isMax) => {
      updateMaxIcon(isMax);
      handleWindowResize();
      window.setTimeout(handleWindowResize, 100);
      window.setTimeout(handleWindowResize, 250);
      window.setTimeout(handleWindowResize, 500);
    });
  }
});


function throttledWindowResize(): void {
  if (S.resizeRaf !== null) return;
  S.resizeRaf = window.requestAnimationFrame(() => {
    S.resizeRaf = null;
    handleWindowResize();
  });
}

window.addEventListener("resize", throttledWindowResize, { passive: true });

/* ---------- Üst bar klavye kısayolları ----------
   Ctrl+1 Mağaza · Ctrl+2 Kütüphane · Ctrl+3 İndirmeler · Ctrl+, Ayarlar */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const targets: Record<string, string> = {
    "1": '[data-act="open-store"]',
    "2": '[data-view="library"]',
    "3": '[data-view="downloads"]',
    ",": '[data-view="settings"]',
  };
  const sel = targets[e.key];
  if (!sel) return;
  e.preventDefault();
  document.querySelector<HTMLElement>(`#nav ${sel}`)?.click();
});

/* ---------- Webview Zırhlama: kazara yenileme ve ölçek bozulmasını engelle ----------
   F5 / Ctrl+R (reload) ve Ctrl +/-/0 (zoom) tarayıcı davranışı konsol deneyimini bozar. */
document.addEventListener(
  "keydown",
  (e) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === "f5" || (ctrl && (k === "r" || k === "+" || k === "-" || k === "=" || k === "0"))) {
      e.preventDefault();
    }
  },
  { capture: true },
);

/* ---------- Başlat ---------- */

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




function ensureGamepadHud(): HTMLElement {
  if (!S.gamepadHudEl) {
    S.gamepadHudEl = document.getElementById("gamepad-hud-bar");
    if (!S.gamepadHudEl) {
      S.gamepadHudEl = document.createElement("div");
      S.gamepadHudEl.id = "gamepad-hud-bar";
      S.gamepadHudEl.className = "gamepad-hud-bar hidden";
      document.body.appendChild(S.gamepadHudEl);
    }
  }
  return S.gamepadHudEl;
}

function updateGamepadHud(active = true): void {
  const hud = ensureGamepadHud();
  if (!active || !S.gamepadPolling) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  hud.classList.remove("dimmed");

  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim()) && Boolean(S.currentModalAppName);

  if (modalOpen) {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>Seç / Oyna</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-b">B</span> <span>Geri</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>Favori</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>Sekmeler</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>Gezin</span></div>
    `;
  } else if (S.view === "profile") {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>Kupaları İncele</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>Profili Yenile</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-y">Y</span> <span>Ara</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>Sekmeler</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>Gezin</span></div>
    `;
  } else {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>Detay</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>Favori</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-y">Y</span> <span>Ara</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>Sekmeler</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>Gezin</span></div>
    `;
  }
}

function initGamepadSupport(): void {
  window.addEventListener("gamepadconnected", (e) => {
    console.log("[Gamepad] Bağlandı:", e.gamepad.id);
    toast(`Oyun Kolu Bağlandı: ${e.gamepad.id.split("(")[0].trim()}`, "ok");
    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      requestAnimationFrame(gamepadLoop);
    }
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    console.log("[Gamepad] Ayrıldı:", e.gamepad.id);
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const hasAny = Array.from(gamepads).some((g) => g !== null && g.connected);
    if (!hasAny) {
      S.gamepadPolling = false;
      updateGamepadHud(false);
    }
  });

  window.addEventListener("mousemove", () => {
    if (S.gamepadHudEl && !S.gamepadHudEl.classList.contains("hidden")) {
      S.gamepadHudEl.classList.add("dimmed");
    }
  }, { passive: true });

  // Başlangıçta halihazırda bağlı oyun kolu var mı?
  setTimeout(() => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (Array.from(gamepads).some((g) => g !== null && g.connected)) {
      if (!S.gamepadPolling) {
        S.gamepadPolling = true;
        updateGamepadHud(true);
        requestAnimationFrame(gamepadLoop);
      }
    }
  }, 1000);
}

function gamepadLoop(): void {
  if (!S.gamepadPolling) return;

  const now = performance.now();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find((g) => g !== null && g.connected);

  if (gp && now - S.lastGamepadActionTime > 170) {
    if (S.gamepadHudEl) S.gamepadHudEl.classList.remove("dimmed");
    const btns = gp.buttons;
    const axes = gp.axes;

    // D-Pad veya Sol Analog Çubuk yönleri
    const up = btns[12]?.pressed || axes[1] < -0.55;
    const down = btns[13]?.pressed || axes[1] > 0.55;
    const left = btns[14]?.pressed || axes[0] < -0.55;
    const right = btns[15]?.pressed || axes[0] > 0.55;

    // Standart Butonlar: 0: A (✕), 1: B (○), 2: X (□), 3: Y (△), 4: L1/LB, 5: R1/RB
    const btnA = btns[0]?.pressed;
    const btnB = btns[1]?.pressed;
    const btnX = btns[2]?.pressed;
    const btnY = btns[3]?.pressed;
    const btnLB = btns[4]?.pressed;
    const btnRB = btns[5]?.pressed;

    if (btnB) {
      // B / Daire (○): Geri / Kapat
      S.lastGamepadActionTime = now;
      if (S.activeLightboxScreenshot) {
        closeScreenshotLightbox();
      } else if (S.currentModalAppName) {
        closeModal();
      } else if (S.view === "store") {
        setView(S.lastNonStoreView);
        render();
      }
    } else if (btnA) {
      // A / Çarpı (✕): Seç / Tıkla
      S.lastGamepadActionTime = now;
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.click === "function") {
        active.click();
      }
    } else if (btnLB || btnRB) {
      // L1/LB & R1/RB: Sekme / Filtre Değiştir
      S.lastGamepadActionTime = now;
      handleGamepadTabSwitch(btnRB ? 1 : -1);
    } else if (btnY) {
      // Y / Üçgen (△): Arama Kutusuna Odaklan
      S.lastGamepadActionTime = now;
      const searchInput = (document.getElementById("ach-search-input") || document.getElementById("search")) as HTMLInputElement | null;
      searchInput?.focus();
    } else if (btnX) {
      // X / Kare (□): Favorilere Ekle / Çıkar
      S.lastGamepadActionTime = now;
      if (S.currentModalAppName) {
        toggleFav(S.currentModalAppName);
      }
    } else if (up || down || left || right) {
      S.lastGamepadActionTime = now;
      if (S.activeLightboxScreenshot && (left || right)) {
        navigateScreenshotLightbox(left ? "prev" : "next");
      } else {
        handleGamepadDirectionalMove(up ? "up" : down ? "down" : left ? "left" : "right");
      }
    }
  }

  requestAnimationFrame(gamepadLoop);
}

function handleGamepadDirectionalMove(dir: "up" | "down" | "left" | "right"): void {
  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim());
  const scope: HTMLElement = modalOpen
    ? document.getElementById("modal-root")!
    : (document.getElementById("view") || document.body);

  if (dir === "down" && S.view === "library" && !modalOpen) {
    const sentinel = document.getElementById("lib-scroll-sentinel");
    if (sentinel) {
      const visible = epicVisibleSummaries();
      if (S.renderedCardCount < visible.length) {
        const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
        const startIdx = S.renderedCardCount;
        S.renderedCardCount += nextSlice.length;
        const newCardsHtml = nextSlice
          .map((s, idx) =>
            S.epicViewMode === "grid"
              ? epicCardPortrait(s, startIdx + idx)
              : epicRowHtml(s)
          )
          .join("");
        sentinel.insertAdjacentHTML("beforebegin", newCardsHtml);
        if (S.renderedCardCount >= visible.length) {
          sentinel.remove();
          S.libScrollObserver?.disconnect();
          S.libScrollObserver = null;
        }
      }
    }
  }

  const selector = 'button:not([disabled]):not(.iconbtn), .pcard, [tabindex="0"], a[href], input:not([disabled]), select:not([disabled])';
  const focusables = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    return el.offsetParent !== null;
  });

  if (focusables.length === 0) return;

  const current = document.activeElement as HTMLElement | null;
  if (!current || !scope.contains(current) || current === document.body) {
    const primaryBtn = scope.querySelector<HTMLElement>(".btn.play, .btn.primary, .pcard");
    if (primaryBtn) {
      primaryBtn.focus();
    } else {
      focusables[0].focus();
    }
    return;
  }

  const curRect = current.getBoundingClientRect();
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 };

  let bestCandidate: HTMLElement | null = null;
  let minDistance = Infinity;

  for (const el of focusables) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    const dx = center.x - curCenter.x;
    const dy = center.y - curCenter.y;

    if (dir === "up" && dy >= -4) continue;
    if (dir === "down" && dy <= 4) continue;
    if (dir === "left" && dx >= -4) continue;
    if (dir === "right" && dx <= 4) continue;

    let dist = 0;
    if (dir === "up" || dir === "down") {
      dist = Math.abs(dy) + Math.abs(dx) * 1.8;
    } else {
      dist = Math.abs(dx) + Math.abs(dy) * 1.8;
    }

    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = el;
    }
  }

  if (bestCandidate) {
    bestCandidate.focus();
    bestCandidate.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

/** LB/RB: üst seviye konsol sekmeleri (Mağaza → Kütüphane → İndirmeler) arasında döner. */
function cycleTopView(step: number): void {
  const order = ['[data-act="open-store"]', '[data-view="library"]', '[data-view="downloads"]'];
  const current = S.view === "store" ? 0 : S.view === "downloads" ? 2 : 1;
  const next = (current + step + order.length) % order.length;
  document.querySelector<HTMLElement>(`#nav ${order[next]}`)?.click();
}

function handleGamepadTabSwitch(step: number): void {
  if (S.currentModalAppName) {
    const tabs: DrawerTab[] = ["overview", "achievements", "dlcs", "screenshots"];
    const curSummary = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
    if (curSummary?.installed) tabs.push("manage");
    tabs.push("specs");

    const curIdx = tabs.indexOf(S.activeDrawerTab);
    const nextIdx = (curIdx + step + tabs.length) % tabs.length;
    S.activeDrawerTab = tabs[nextIdx];
    openEpicModal(S.currentModalAppName, false, true);
  } else {
    cycleTopView(step);
  }
  updateGamepadHud(S.gamepadPolling);
}

void init();
