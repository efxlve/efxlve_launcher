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
import { registerRender } from "./core/render";
import { epicWideArt, isTurkishUser, rawOf, setEpicGamesRaw, setEpicSummaries, summaryOf } from "./core/selectors";
import { initContextMenu } from "./features/context-menu/context-menu";
import { renderDlcManager, renderDlcRows } from "./features/dlc/dlc-manager";
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
const CUSTOM_COVERS_KEY = "efxlve-custom-covers";
const CUSTOM_HEROES_KEY = "efxlve-custom-heroes";


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

function saveCustomCover(appName: string, url: string): void {
  S.customCovers[appName] = url.trim();
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(S.customCovers));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function resetCustomCover(appName: string): void {
  delete S.customCovers[appName];
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(S.customCovers));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function saveCustomHero(appName: string, url: string): void {
  S.customHeroes[appName] = url.trim();
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(S.customHeroes));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function resetCustomHero(appName: string): void {
  delete S.customHeroes[appName];
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(S.customHeroes));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

/* ---------- SteamGridDB Durum Değişkenleri ---------- */

















function cleanSteamGridSearchTerm(title: string): string {
  let s = title.trim();
  const prefixes = [
    "Tom Clancy's ",
    "Marvel's ",
    "Sid Meier's ",
    "Disney's ",
    "EA SPORTS™ ",
    "EA SPORTS ",
    "Star Wars™ ",
    "STAR WARS™ ",
    "STAR WARS ",
    "Warhammer 40,000: ",
    "Warhammer: ",
  ];
  for (const p of prefixes) {
    if (s.startsWith(p)) s = s.substring(p.length);
  }
  const dashPos = s.indexOf(" - ");
  if (dashPos !== -1) {
    const sub = s.substring(dashPos + 3).toLowerCase();
    if (sub.includes("edition") || sub.includes("cut") || sub.includes("version")) {
      s = s.substring(0, dashPos);
    }
  }
  const suffixes = [
    " Standard Edition",
    " Enhanced Edition",
    " Definitive Edition",
    " Gold Edition",
    " Deluxe Edition",
    " Complete Edition",
    " Game of the Year Edition",
    " GOTY Edition",
    " Special Edition",
    " Remastered",
    " Director's Cut",
  ];
  for (const suffix of suffixes) {
    const idx = s.toLowerCase().indexOf(suffix.toLowerCase());
    if (idx !== -1) {
      s = s.substring(0, idx);
    }
  }
  return s.trim();
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

function pruneRecent(): void {
  S.epicRecent = S.epicRecent.filter((id) =>
    S.epicSummaries.some((s) => s.appName === id && s.installed),
  );
  localStorage.setItem(RECENT_KEY, JSON.stringify(S.epicRecent));
}

function pushRecent(appName: string): void {
  const s = summaryOf(appName);
  if (!s || !s.installed) return;
  S.epicRecent = [appName, ...S.epicRecent.filter((x) => x !== appName)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(S.epicRecent));
  updateChrome();
}

/** Üst bar hesap çipini tazeler. */
function updateChrome(): void {
  const acc = document.getElementById("account");
  if (acc) {
    const name = S.epicAccount || "Giriş yapılmadı";
    if (acc.dataset.acct !== (S.epicAccount || "")) {
      acc.dataset.acct = S.epicAccount || "";
      if (S.epicAccount) {
        const initial = (S.epicAccount.trim()[0] || "?").toUpperCase();
        acc.innerHTML =
          `<span class="account-avatar"><span class="avatar-initial">${esc(initial)}</span></span>` +
          `<span class="account-name">${esc(name)}</span>`;
      } else {
        acc.innerHTML =
          `<span class="account-avatar"><i data-lucide="circle-user-round"></i></span>` +
          `<span class="account-name">${t("nav.notLoggedIn")}</span>`;
        createIcons({ icons: { CircleUserRound } });
      }
    }
    acc.classList.toggle("logged", !!S.epicAccount);
    acc.title = S.epicAccount
      ? `Epic profili: ${name} (Profil için tıklayın)`
      : "Epic hesabına giriş yapılmadı (Giriş için tıklayın)";
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

async function epicPlay(appName: string): Promise<void> {
  pushRecent(appName);
  toast("Oyun başlatılıyor…", "");
  try {
    const msg = await epicLaunchGame(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
}

function gameById(id: string): Game | undefined {
  return S.games.find((g) => g.id === id);
}

function updateBadge(): void {
  const active = [...S.downloads.values()].filter((d) => !d.done).length;
  dlBadge.textContent = active > 0 ? String(active) : "";
  dlBadge.classList.toggle("hidden", active === 0);
  // Sayaç satır içi olduğu için sekme genişliği değişir → kayan göstergeyi tazele.
  updateNavIndicator();
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

async function openSelectiveModal(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (s?.installed) {
    // Kurulu oyun için doğrudan güncelleme/onarım çalıştır
    void epicInstall(appName);
    return;
  }
  toast("Kurulum seçenekleri denetleniyor…", "");
  try {
    const opts = await epicGetInstallOptions(appName);
    if (!opts.hasOptions) {
      void epicInstall(appName);
      return;
    }
    S.selectiveInstallOptions = opts;
    S.selectedInstallTags.clear();
    S.selectedDlcAppIds.clear();
    renderSelectiveModal();
  } catch (_err) {
    void epicInstall(appName);
  }
}

async function applySelectiveInstall(appName: string, tags: string[], dlcs: string[]): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s ? s.title : appName;
  closeSelectiveModal();
  S.downloads.set(appName, { progress: 0, done: false, title });
  if (!S.activeDlMetrics || S.activeDlMetrics.done) {
    S.activeDlMetrics = {
      id: appName,
      title,
      progress: 0,
      done: false,
      speed: "Başlatılıyor…",
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: "Hesaplanıyor…",
      downloadedBytes: 0,
      totalBytes: 0,
    };
  }
  updateBadge();
  render();
  toast("Seçici kurulum başlatılıyor…", "");
  try {
    const msg = await epicInstallWithOptions(appName, tags, dlcs, null);
    toast(msg, "ok");
    void refreshEpicInstalled();
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    render();
    toast(`Kurulum başlatılamadı: ${String(e)}`, "err");
  }
}

function closeSelectiveModal(): void {
  S.selectiveInstallOptions = null;
  S.selectedInstallTags.clear();
  S.selectedDlcAppIds.clear();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
}

function renderSelectiveModal(): void {
  if (!selectiveRoot || !S.selectiveInstallOptions) return;
  const opts = S.selectiveInstallOptions;

  const existingBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  const scrollPos = existingBody ? existingBody.scrollTop : 0;

  const langTags = opts.tags.filter((t) => t.category === "languages");
  const extraTags = opts.tags.filter((t) => t.category === "extras");
  const uninstalledDlcs = opts.dlcs.filter((d) => !d.installed);

  let totalDl = opts.baseDownloadSize || opts.baseSize;
  let totalDisk = opts.baseSize;

  for (const tag of opts.tags) {
    if (S.selectedInstallTags.has(tag.tag)) {
      totalDl += tag.downloadSize || tag.size;
      totalDisk += tag.size;
    }
  }

  for (const dlc of opts.dlcs) {
    if (S.selectedDlcAppIds.has(dlc.appId)) {
      totalDl += dlc.size;
      totalDisk += dlc.size;
    }
  }

  let langsHtml = "";
  if (langTags.length > 0) {
    langsHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          <span style="font-size:11px">▾</span> Ek Diller (${langTags.length})
        </div>
        <div class="selective-accordion-list">
          ${langTags
            .map((t) => {
              const isChecked = S.selectedInstallTags.has(t.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(t.label)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(t.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(t.tag)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  let extrasHtml = "";
  if (extraTags.length > 0) {
    extrasHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          <span style="font-size:11px">▾</span> Ek Paketler &amp; Dokular (${extraTags.length})
        </div>
        <div class="selective-accordion-list">
          ${extraTags
            .map((t) => {
              const isChecked = S.selectedInstallTags.has(t.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(t.label)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(t.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(t.tag)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  let dlcsHtml = "";
  if (uninstalledDlcs.length > 0) {
    dlcsHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          <span style="font-size:11px">▾</span> Eklentiler &amp; DLC (${uninstalledDlcs.length})
        </div>
        <div class="selective-accordion-list">
          ${uninstalledDlcs
            .map((d) => {
              const isChecked = S.selectedDlcAppIds.has(d.appId);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(d.title)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(d.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-dlc" data-dlc="${esc(d.appId)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  selectiveRoot.innerHTML = `
    <div class="selective-overlay" data-act="selective-overlay-close">
      <div class="selective-dialog">
        <div class="selective-header">
          <h2>${esc(opts.title)} Yükleme Seçenekleri</h2>
          <button class="manage-head-close" data-act="selective-close" title="Kapat">${icon("x", 16)}</button>
        </div>
        <div class="selective-body">
          <div class="selective-row base">
            <div class="selective-row-info">
              <span class="selective-row-label">${esc(opts.title)} <span class="muted-sub">(Gerekli)</span></span>
            </div>
            <div class="selective-row-right">
              <span class="selective-row-size">${fmtBytes(opts.baseSize)}</span>
              <input type="checkbox" class="selective-checkbox" checked disabled />
            </div>
          </div>

          ${langsHtml}
          ${extrasHtml}
          ${dlcsHtml}
        </div>

        <div class="selective-footer">
          <div class="selective-footer-stats">
            <span>İndirilecek Dosya Boyutu: <strong>${fmtBytes(totalDl)}</strong></span>
            <span>Gerekli Depolama Alanı: <strong>${fmtBytes(totalDisk)}</strong></span>
          </div>
          <button class="selective-apply-btn" data-act="selective-apply" data-id="${esc(opts.appName)}">
            Uygula
          </button>
        </div>
      </div>
    </div>
  `;

  const newBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  if (newBody && scrollPos > 0) newBody.scrollTop = scrollPos;
}

/* ---------- Top bar: active tab underline ---------- */

function updateNavIndicator(): void {
  const bar = document.getElementById("titlebar");
  const seg = document.getElementById("nav-seg");
  const ind = document.getElementById("nav-indicator");
  if (!bar || !seg || !ind) return;
  const active = seg.querySelector<HTMLElement>(".nav-tab.active");
  if (!active) {
    ind.style.opacity = "0";
    return;
  }
  if (!S.navIndicatorReady) {
    // İlk konumlandırmada animasyon oynamasın (0 genişlikten kaymasın).
    ind.style.transition = "none";
    S.navIndicatorReady = true;
    window.setTimeout(() => { ind.style.transition = ""; }, 80);
  }
  const barRect = bar.getBoundingClientRect();
  const tabRect = active.getBoundingClientRect();
  ind.style.width = `${tabRect.width}px`;
  ind.style.transform = `translateX(${tabRect.left - barRect.left}px)`;
  ind.style.opacity = "1";
}



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

async function refreshUpdates(): Promise<void> {
  if (!isTauri) return;
  try {
    const updates = await epicCheckUpdates();
    S.availableUpdates.clear();
    for (const u of updates) {
      S.availableUpdates.set(u.appName, u);
    }
    if (S.availableUpdates.size > 0 && S.view === "library") {
      scheduleRender();
    }
  } catch (e) {
    console.warn("Güncelleme denetimi yapılamadı:", e);
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



function updateDrawerTabArrows(): void {
  const wrapper = modalRoot.querySelector(".drawer-tabs-wrapper") as HTMLElement | null;
  const container = document.getElementById("drawer-tabs-scrollable");
  if (!wrapper || !container) return;

  const leftFade = wrapper.querySelector(".drawer-tabs-fade.left") as HTMLElement | null;
  const rightFade = wrapper.querySelector(".drawer-tabs-fade.right") as HTMLElement | null;

  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = maxScroll > 4;

  const canScrollLeft = hasOverflow && container.scrollLeft > 4;
  const canScrollRight = hasOverflow && container.scrollLeft < maxScroll - 4;

  if (leftFade) leftFade.classList.toggle("visible", canScrollLeft);
  if (rightFade) rightFade.classList.toggle("visible", canScrollRight);
}

function ensureTabVisible(el: HTMLElement, container: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  // If already comfortably visible inside container bounds, do not scroll!
  if (elRect.left >= containerRect.left + 8 && elRect.right <= containerRect.right - 8) {
    return;
  }

  // Only if clipped on the right, scroll just enough to reveal it
  if (elRect.right > containerRect.right - 8) {
    const diff = elRect.right - containerRect.right + 16;
    container.scrollBy({ left: diff, behavior: "smooth" });
  } else if (elRect.left < containerRect.left + 8) {
    // Only if clipped on the left, scroll just enough to reveal it
    const diff = containerRect.left - elRect.left + 16;
    container.scrollBy({ left: -diff, behavior: "smooth" });
  }
}

function openEpicModal(appName: string, isInitialOpen = true, animateTabContent = true): void {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s) return;
  S.currentModalAppName = appName;
  if (isInitialOpen) {
    S.activeDrawerTab = "overview";
    S.activeAchScope = "all";
    S.activeAchFilter = "all";
    S.achSearchQuery = "";
    S.achSortOrder = "default";
  }
  const prevOverlay = modalRoot.querySelector(".overlay") as HTMLElement | null;
  const prevScroll = !isInitialOpen && prevOverlay ? prevOverlay.scrollTop : 0;
  const g = rawOf(appName);
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  const faved = S.epicFav.has(appName);
  const devRaw = g ? g.metadata.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";
  const p = epicDlProgress(appName);
  const isPlat = isAppPlatinum(appName);
  const achSum = S.epicAchSummaries[appName];
  const partner = getThirdPartyLauncher(g);
  const antiCheat = getAntiCheat(g);

  const pt = S.playtimeMap.get(appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—";

  let achStatVal = "—";
  if (achSum && achSum.total_achievements > 0) {
    const pct = Math.round((achSum.user_unlocked / achSum.total_achievements) * 100);
    achStatVal = `${achSum.user_unlocked}/${achSum.total_achievements} (%${pct})`;
  }

  const hltb = S.loadedHltb.get(appName);
  const hltbVal = hltb?.main_story ? `~${hltb.main_story} sa` : (hltb?.main_extra ? `~${hltb.main_extra} sa` : "—");
  const hltbLoading = S.loadingHltbFor === appName;

  const critic = S.loadedCritic.get(appName);
  const criticLoading = S.loadingCriticFor === appName;
  let criticVal = "—";
  let criticTierClass = "";
  const showGoygoy = isTurkishUser() && Boolean(critic?.goygoy_review);
  const criticUrl = critic?.opencritic_url || critic?.metacritic_url || (showGoygoy ? critic?.goygoy_review?.url : "") || "";
  if (critic && critic.supported) {
    const sc = critic.opencritic_score || critic.metacritic_score;
    if (sc) {
      criticVal = critic.tier ? `${sc} • ${critic.tier}` : `${sc}`;
      if (critic.tier) {
        criticTierClass = `tier-${critic.tier.toLowerCase()}`;
      }
    } else if (showGoygoy && critic.goygoy_review?.score) {
      criticVal = `${critic.goygoy_review.score} • Goygoy`;
      criticTierClass = "tier-goygoy";
    } else if (showGoygoy && critic.goygoy_review) {
      criticVal = "Goygoy İnceleme";
      criticTierClass = "tier-goygoy";
    }
  }

  const isRunning = S.runningGames.has(appName);
  const primary =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : isRunning
        ? `<button class="btn primary running" data-id="${s.appName}"><span class="running-dot"></span> Oynanıyor…</button>`
        : s.installed
          ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} Hemen Oyna</button>`
          : partner
            ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 16)} ${esc(partner.name)} ile Başlat / Yükle</button>`
            : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} Yükle</button>`;

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== "Açıklama yok." &&
    rawDesc !== s.title &&
    rawDesc.length > 25;
  const descHtml = hasRealDesc
    ? `<div class="drawer-desc">${esc(rawDesc)}</div>`
    : "";

  const achPill = isPlat
    ? `<span class="status-pill plat" style="background:linear-gradient(135deg,rgba(168,85,247,0.22),rgba(126,34,206,0.38));color:#f3e8ff;border:1px solid rgba(192,132,252,0.4);font-weight:700">${epicPlatinumIcon(13)} Platin Kupa</span>`
    : achSum && achSum.total_achievements > 0
      ? `<span class="status-pill ach" style="color:#c084fc;border-color:rgba(192,132,252,0.35);background:rgba(168,85,247,0.12)">${icon("trophy", 12)} ${achSum.user_unlocked}/${achSum.total_achievements} Başarım</span>`
      : "";


  const dlcRes = S.dlcCache.get(s.appName);
  const currentDlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const dlcTabBadge = currentDlcCount > 0
    ? `<span class="drawer-tab-badge">(${currentDlcCount})</span>`
    : "";

  const currentSsCount = S.loadedScreenshots.get(appName)?.length ?? 0;
  const ssTabBadge = currentSsCount > 0
    ? `<span class="drawer-tab-badge">(${currentSsCount})</span>`
    : "";

  if (S.activeDrawerTab === "overview" && !S.loadedHltb.has(appName) && S.loadingHltbFor !== appName) {
    S.loadingHltbFor = appName;
    epicGetHltb(s.title, s.appName)
      .then((data) => {
        S.loadedHltb.set(appName, data);
        S.loadingHltbFor = null;
        const el = document.getElementById("drawer-hltb-container");
        if (el && S.currentModalAppName === appName) {
          el.innerHTML = renderHltbCard(data);
        }
        const capEl = document.getElementById("hub-stat-hltb-val");
        if (capEl && S.currentModalAppName === appName) {
          capEl.textContent = data?.main_story ? `~${data.main_story} sa` : (data?.main_extra ? `~${data.main_extra} sa` : "—");
        }
      })
      .catch(() => {
        S.loadingHltbFor = null;
      });
  }

  if (S.activeDrawerTab === "overview" && !S.loadedCritic.has(appName) && S.loadingCriticFor !== appName) {
    S.loadingCriticFor = appName;
    epicGetCritic(s.title, s.appName)
      .then((data) => {
        S.loadedCritic.set(appName, data);
        S.loadingCriticFor = null;
        if (S.currentModalAppName === appName) {
          updateCriticUI(appName, data);
        }
      })
      .catch(() => {
        S.loadingCriticFor = null;
      });
  }

  if (!S.loadedRequirements.has(appName) && S.loadingReqFor !== appName) {
    void fetchAndRenderRequirements(appName, s.title);
  }

  if (!S.loadedScreenshots.has(appName) && S.loadingScreenshotsFor !== appName) {
    void fetchAndRenderScreenshots(appName, s.title);
  }

  if (!isInitialOpen) {
    const existingHub = modalRoot.querySelector(".game-hub, .drawer") as HTMLElement | null;
    const overlayEl = modalRoot.querySelector(".overlay") as HTMLElement | null;
    const contentEl = document.getElementById("drawer-tab-content");
    if (existingHub && contentEl && S.currentModalAppName === appName) {
      modalRoot.querySelectorAll(".drawer-tab").forEach((btn) => {
        const el = btn as HTMLElement;
        const isActive = el.dataset.tab === S.activeDrawerTab;
        el.classList.toggle("active", isActive);
        if (isActive) {
          const container = document.getElementById("drawer-tabs-scrollable");
          if (container) ensureTabVisible(el, container);
        }
      });

      const overlayScroll = overlayEl ? overlayEl.scrollTop : (existingHub ? existingHub.scrollTop : 0);
      const achList = contentEl.querySelector(".ach-list, .ach-list-container") as HTMLElement | null;
      const achScroll = achList ? achList.scrollTop : 0;

      contentEl.innerHTML =
        S.activeDrawerTab === "overview"
          ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
          : S.activeDrawerTab === "achievements"
            ? renderDrawerAchievements(s)
            : S.activeDrawerTab === "dlcs"
              ? renderDrawerDlcs(s)
              : S.activeDrawerTab === "screenshots"
                ? renderDrawerScreenshots(s)
                : S.activeDrawerTab === "manage"
                  ? renderDrawerManage(s)
                  : renderDrawerSystemRequirements(s);

      if (animateTabContent) {
        contentEl.classList.remove("tab-content-enter");
        void contentEl.offsetWidth;
        contentEl.classList.add("tab-content-enter");
      } else {
        contentEl.classList.remove("tab-content-enter");
      }

      if (overlayEl) overlayEl.scrollTop = overlayScroll;
      if (existingHub) existingHub.scrollTop = overlayScroll;
      if (achScroll > 0) {
        const nextAchList = contentEl.querySelector(".ach-list, .ach-list-container") as HTMLElement | null;
        if (nextAchList) nextAchList.scrollTop = achScroll;
      }

      const achTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="achievements"]');
      if (achTabBtn) {
        achTabBtn.innerHTML = `${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)} Başarımlar`;
        achTabBtn.classList.toggle("plat", isPlat);
      }
      const dlcTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
      if (dlcTabBtn) {
        dlcTabBtn.innerHTML = `${icon("layers", 13)} Eklentiler ${dlcTabBadge}`;
      }

      requestAnimationFrame(() => {
        updateDrawerTabArrows();
      });

      return;
    }
  }

  modalRoot.innerHTML = `
    <div class="overlay" data-act="close">
      <div class="game-hub">
        <!-- 4K Sinematik Arka Plan & Derin PS5 Atmosferik Degrade -->
        <div class="hub-backdrop">
          ${art ? `<img src="${art}" alt="" />` : `<div class="hub-fallback-art">${icon("gamepad-2", 64)}</div>`}
          <div class="hub-backdrop-gradient"></div>
        </div>

        <!-- 1260px Genişliğindeki Konsol Sahnesi -->
        <div class="hub-stage">
          <!-- Üst Bar: Geri Butonu & Araçlar -->
          <div class="hub-topbar">
            <button class="hub-back-btn" data-act="close" title="Kütüphaneye Dön (ESC)">
              ${icon("arrow-left", 16)}
              <span>Kütüphane</span>
              <span class="hub-back-esc">ESC</span>
            </button>
            <div class="hub-topbar-tools">
              <button class="hub-tool-btn" data-act="open-custom-cover" data-target="hero" data-id="${s.appName}" title="Afiş ve Kapak Görselini Özelleştir">
                ${icon("image", 15)}
              </button>
              <button class="hub-tool-btn" data-act="close" title="Kapat">
                ${icon("x", 16)}
              </button>
            </div>
          </div>

          <!-- Hero Başlık ve Hızlı Kapsül -->
          <div class="hub-hero">
            <div class="hub-hero-main">
              <h1 class="hub-title">${esc(s.title)}</h1>
              <div class="hub-meta-subline">
                ${dev ? `<span class="meta-item dev">${esc(dev)}</span><span class="meta-dot">•</span>` : ""}
                <span class="meta-item status ${s.installed ? "installed" : ""}">${s.installed ? "Kurulu" : "Kurulu Değil"}</span>
                ${partner ? `<span class="meta-dot">•</span><span class="meta-item partner" title="${esc(partner.name)} başlatıcısı gereklidir">${icon("layers", 12)} ${esc(partner.name)}</span>` : ""}
                ${antiCheat ? `<span class="meta-dot">•</span><span class="meta-item anticheat" title="Hile Koruması: ${esc(antiCheat)}">${icon("shield", 12)} ${esc(antiCheat)}</span>` : ""}
                ${s.updateAvailable ? `<span class="meta-dot">•</span><span class="meta-item warn">${icon("zap", 11)} Güncelleme Mevcut</span>` : ""}
              </div>

              <div class="hub-actions-bar">
                ${primary}
                <button class="btn ghost ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favorilere Ekle / Çıkar">
                  ${icon("heart", 15)} <span>${faved ? "Favorilerde" : "Favori"}</span>
                </button>
                <button class="btn ghost" data-act="epic-store-page" data-id="${s.appName}" title="Epic Games Store Sayfasını Aç">
                  ${icon("external", 15)} <span>Mağaza</span>
                </button>
                ${p !== null ? `<button class="btn ghost danger" data-act="epic-cancel" data-id="${s.appName}">${icon("x", 15)} <span>İptal</span></button>` : ""}
              </div>
            </div>

            <!-- Sağ Taraf: Hızlı Stat Kapsülü (PS5 Glass Capsule) -->
            <div class="hub-stat-capsule">
              <div class="hub-stat-col clickable" data-act="open-edit-playtime" data-id="${s.appName}" title="Oynama süresini düzenle">
                <span class="hub-stat-label">${icon("clock", 11)} SÜRE</span>
                <span class="hub-stat-val" id="drawer-stat-playtime">${esc(playtimeStr)}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${achSum && achSum.total_achievements > 0 ? "clickable" : ""}" ${achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}"` : ""} title="Başarımları Gör">
                <span class="hub-stat-label ${isPlat ? "plat" : ""}">${isPlat ? epicPlatinumIcon(11) : icon("trophy", 11)} ${isPlat ? "PLATİN" : "KUPA"}</span>
                <span class="hub-stat-val ${isPlat ? "plat" : ""}">${achStatVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col" title="HowLongToBeat Hikaye Süresi">
                <span class="hub-stat-label">${icon("timer", 11)} HİKAYE</span>
                <span class="hub-stat-val" id="hub-stat-hltb-val">${hltbLoading ? `<span class="hltb-spinner"></span>` : hltbVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${criticUrl ? "clickable" : ""}" id="hub-stat-critic-col" ${criticUrl ? `data-act="open-critic-url" data-url="${esc(criticUrl)}"` : ""} title="Eleştirmen İnceleme Skoru">
                <span class="hub-stat-label">${icon("star", 11)} İNCELEME</span>
                <span class="hub-stat-val ${criticTierClass}" id="hub-stat-critic-val">${criticLoading ? `<span class="hltb-spinner"></span>` : criticVal}</span>
              </div>
            </div>
          </div>

          <!-- Sekme Başlıkları -->
          <div class="drawer-tabs-wrapper">
            <div class="drawer-tabs-fade left">
              <button class="drawer-tabs-arrow left" data-act="drawer-tabs-scroll" data-dir="left" title="Sola kaydır">
                ${icon("chevron-left", 13)}
              </button>
            </div>
            <div class="drawer-tabs" id="drawer-tabs-scrollable">
              <button class="drawer-tab ${S.activeDrawerTab === "overview" ? "active" : ""}" data-act="drawer-tab" data-tab="overview">
                ${icon("gamepad-2", 13)} Genel Bakış
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "achievements" ? "active" : ""} ${isPlat ? "plat" : ""}" data-act="drawer-tab" data-tab="achievements" data-id="${appName}">
                ${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)} Başarımlar
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "dlcs" ? "active" : ""}" data-act="drawer-tab" data-tab="dlcs" data-id="${appName}">
                ${icon("layers", 13)} Eklentiler ${dlcTabBadge}
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "screenshots" ? "active" : ""}" data-act="drawer-tab" data-tab="screenshots" data-id="${appName}">
                ${icon("image", 13)} Ekran Görüntüleri ${ssTabBadge}
              </button>
              ${s.installed ? `
              <button class="drawer-tab ${S.activeDrawerTab === "manage" ? "active" : ""}" data-act="drawer-tab" data-tab="manage" data-id="${appName}">
                ${icon("settings", 13)} Yönet
              </button>` : ""}
              <button class="drawer-tab ${S.activeDrawerTab === "specs" ? "active" : ""}" data-act="drawer-tab" data-tab="specs" data-id="${appName}">
                ${icon("monitor", 13)} Sistem
              </button>
            </div>
            <div class="drawer-tabs-fade right">
              <button class="drawer-tabs-arrow right" data-act="drawer-tabs-scroll" data-dir="right" title="Sağa kaydır">
                ${icon("chevron-right", 13)}
              </button>
            </div>
          </div>

          <!-- Sekme İçeriği -->
          <div id="drawer-tab-content" class="${animateTabContent ? "tab-content-enter" : ""}">
            ${
              S.activeDrawerTab === "overview"
                ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
                : S.activeDrawerTab === "achievements"
                  ? renderDrawerAchievements(s)
                  : S.activeDrawerTab === "dlcs"
                    ? renderDrawerDlcs(s)
                    : S.activeDrawerTab === "screenshots"
                      ? renderDrawerScreenshots(s)
                      : S.activeDrawerTab === "manage"
                        ? renderDrawerManage(s)
                        : renderDrawerSystemRequirements(s)
            }
          </div>
        </div>
      </div>
    </div>`;

  if (prevScroll > 0) {
    const nextOverlay = modalRoot.querySelector(".overlay") as HTMLElement | null;
    if (nextOverlay) nextOverlay.scrollTop = prevScroll;
  }

  requestAnimationFrame(() => {
    updateDrawerTabArrows();
    const container = document.getElementById("drawer-tabs-scrollable");
    if (container && !(container as any)._hasScrollListener) {
      (container as any)._hasScrollListener = true;
      container.addEventListener("scroll", updateDrawerTabArrows, { passive: true });
    }
  });

  if (!S.dlcCache.has(appName)) {
    epicGetGameDlcs(appName)
      .then((res) => {
        S.dlcCache.set(appName, res);
        const cur = S.epicSummaries.find((x) => x.appName === appName);
        if (cur) cur.dlcCount = res.dlcs.length;
        if (S.currentModalAppName === appName) {
          const dlcTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
          if (dlcTabBtn) {
            const badgeEl = dlcTabBtn.querySelector(".drawer-tab-badge");
            if (res.dlcs.length > 0) {
              if (badgeEl) {
                badgeEl.textContent = `(${res.dlcs.length})`;
              } else {
                dlcTabBtn.insertAdjacentHTML("beforeend", ` <span class="drawer-tab-badge">(${res.dlcs.length})</span>`);
              }
            } else if (badgeEl) {
              badgeEl.remove();
            }
          }
        }
      })
      .catch(() => {});
  }
  updateGamepadHud(S.gamepadPolling);
}

function updateCriticUI(appName: string, data: CriticData): void {
  const container = document.getElementById("drawer-critic-container");
  if (container && S.currentModalAppName === appName) {
    container.innerHTML = renderCriticCard(data, false);
  }
  const capValEl = document.getElementById("hub-stat-critic-val");
  const capColEl = document.getElementById("hub-stat-critic-col");
  if (capValEl && S.currentModalAppName === appName) {
    const showGoygoy = isTurkishUser() && Boolean(data.goygoy_review);
    const sc = data.opencritic_score || data.metacritic_score;
    if (sc) {
      capValEl.textContent = data.tier ? `${sc} • ${data.tier}` : `${sc}`;
      if (data.tier) {
        capValEl.className = `hub-stat-val tier-${data.tier.toLowerCase()}`;
      } else {
        capValEl.className = "hub-stat-val";
      }
    } else if (showGoygoy && data.goygoy_review?.score) {
      capValEl.textContent = `${data.goygoy_review.score} • Goygoy`;
      capValEl.className = "hub-stat-val tier-goygoy";
    } else if (showGoygoy && data.goygoy_review) {
      capValEl.textContent = "Goygoy İnceleme";
      capValEl.className = "hub-stat-val tier-goygoy";
    } else {
      capValEl.textContent = "—";
      capValEl.className = "hub-stat-val";
    }

    const url = data.opencritic_url || data.metacritic_url || (showGoygoy ? data.goygoy_review?.url : "");
    if (url && capColEl) {
      capColEl.classList.add("clickable");
      capColEl.setAttribute("data-act", "open-critic-url");
      capColEl.setAttribute("data-url", url);
    } else if (capColEl) {
      capColEl.classList.remove("clickable");
      capColEl.removeAttribute("data-act");
      capColEl.removeAttribute("data-url");
    }
  }
}

function renderDrawerOverview(
  s: EpicSummary,
  _primary: string,
  _faved: boolean,
  _p: number | null,
  _descHtml: string,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
): string {
  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );

  const hltb = S.loadedHltb.get(s.appName);
  const hltbLoading = S.loadingHltbFor === s.appName;
  const critic = S.loadedCritic.get(s.appName);
  const criticLoading = S.loadingCriticFor === s.appName;
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  const achSum = S.epicAchSummaries[s.appName];

  // Koleksiyon etiketleri (Eklentiler sekmesi yukarıda olduğu için burada yalnızca koleksiyonlar listelenir)
  let tagsHtml = "";
  if (gameCols.length > 0) {
    const pills = gameCols.map((c) => `
      <button class="drawer-tag" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(c.name)} koleksiyonunu göster">
        ${c.emoji ? `<span>${esc(c.emoji)}</span>` : ""}<span>${esc(c.name)}</span>
      </button>
    `).join("");
    const addBtn = `<button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} Koleksiyon</button>`;
    tagsHtml = `<div class="drawer-tags-row">${pills}${addBtn}</div>`;
  } else {
    tagsHtml = `<div class="drawer-tags-row"><button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} Koleksiyon Ekle</button></div>`;
  }

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== "Açıklama yok." &&
    rawDesc !== s.title &&
    rawDesc.length > 25;
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : null);
  const effectiveDesc = hasRealDesc ? rawDesc : (storeDesc || null);
  const descText = effectiveDesc ? esc(effectiveDesc) : "Bu oyun için katalog açıklaması henüz eklenmemiş.";

  return `
    <div class="hub-overview-layout">
      <!-- Sol / Ana Alan: Açıklama, Etiketler, Kupa & Medya Vitrini -->
      <div class="hub-overview-main">
        <div class="hub-card hub-desc-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("info", 14)} <span>Oyun Hakkında</span></h3>
          </div>
          <div class="hub-desc-text" id="hub-desc-text">${descText}</div>
        </div>

        <div class="hub-card hub-tags-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("folder", 14)} <span>Koleksiyonlar & Etiketler</span></h3>
          </div>
          ${tagsHtml}
        </div>

        ${renderOverviewTrophySpotlight(s, g, achSum, partner)}

        <div id="overview-media-container">
          ${renderOverviewMediaSpotlight(s)}
        </div>
      </div>

      <!-- Sağ / Kenar Çubuğu: İncelemeler, HowLongToBeat & Özellikler -->
      <div class="hub-overview-sidebar">
        <div id="drawer-critic-container">
          ${renderCriticCard(critic, criticLoading)}
        </div>

        <div id="drawer-hltb-container">
          ${renderHltbCard(hltb, hltbLoading)}
        </div>

        <div class="hub-card hub-features-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("layers", 14)} <span>Oyun Özellikleri & Destek</span></h3>
          </div>
          <div class="hub-features-list" id="hub-features-list">
            ${renderGameFeatures(s, g, partner, antiCheat, reqData)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderDrawerDlcs(s: EpicSummary): string {
  const dlcRes = S.dlcCache.get(s.appName);
  if (S.dlcLoading && !dlcRes) {
    return `
      <div style="text-align:center;padding:50px 0;">
        <div class="spinner" style="margin:0 auto 16px"></div>
        <div class="muted">Eklentiler taranıyor…</div>
      </div>
    `;
  }
  const allDlcs = dlcRes?.dlcs || [];
  const query = S.dlcSearchQuery.trim().toLowerCase();
  const filteredDlcs = query
    ? allDlcs.filter((d) => d.title.toLowerCase().includes(query))
    : allDlcs;

  if (allDlcs.length === 0) {
    return `
      <div class="dlc-drawer-tab">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:36px 20px;text-align:center;">
          <div style="color:var(--muted);margin-bottom:10px">${icon("package", 32)}</div>
          <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:6px">Kayıtlı Eklenti Bulunmuyor</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:18px">Bu oyun için kütüphanenizde eklenti veya ek içerik kaydı yok.</div>
          <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
            ${icon("external", 13)} Mağazada Eklentileri Keşfet
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="dlc-drawer-tab">
      <div class="dlc-drawer-search-bar">
        ${icon("search", 15)}
        <input id="dlc-drawer-search" placeholder="Eklentiler arasında ara…" value="${esc(S.dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
      </div>

      <div class="dlc-drawer-list">
        ${filteredDlcs.map((dlc) => {
          const isDownloadable = dlc.downloadable !== false;
          const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : (isDownloadable ? "—" : "Oyuna Dahil");
          const thumbHtml = dlc.image
            ? `<img class="dlc-drawer-thumb" src="${esc(dlc.image)}" alt="" />`
            : `<div class="dlc-drawer-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">${icon("layers", 14)}</div>`;

          const actionHtml = isDownloadable
            ? `
              <label class="toggle-switch" style="flex-shrink:0" title="${dlc.installed ? "Kaldır" : "Yükle"}">
                <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(s.appName)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            `
            : `
              <span class="dlc-badge-active" title="Bu içerik ana oyuna entegredir ve Epic hesabınızda etkindir.">
                ${icon("check", 12)} Hesapta Aktif
              </span>
            `;

          return `
            <div class="dlc-drawer-item">
              <div class="dlc-drawer-left">
                ${thumbHtml}
                <div style="min-width:0">
                  <div class="dlc-drawer-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div>
                  <div class="dlc-drawer-size">${esc(sizeStr)}</div>
                </div>
              </div>
              ${actionHtml}
            </div>
          `;
        }).join("")}
      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;margin-top:6px">
        <div style="font-size:12px;color:var(--muted)">Daha fazla eklenti ve genişletme keşfet</div>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
          ${icon("external", 12)} Mağaza
        </button>
      </div>
    </div>
  `;
}

function renderDrawerManage(s: EpicSummary): string {
  if (!S.activeManageSettings || S.activeManageSettings.appName !== s.appName) {
    S.activeManageSettings = {
      appName: s.appName,
      title: s.title,
      launchParameters: "",
      autoUpdate: true,
      highPriority: false,
      cloudSavesEnabled: true,
      lastCloudSync: null,
      installSize: s.installSize || 0,
      installPath: s.installPath || "",
      version: s.installedVersion || s.version || "1.0",
    };
    epicGetGameSettings(s.appName).then((st) => {
      if (S.activeManageSettings?.appName === s.appName) {
        S.activeManageSettings = st;
        updateManageModalInputsInPlace(st);
      }
    }).catch(() => {});
  } else if (s.installPath && s.installPath !== S.activeManageSettings.installPath) {
    S.activeManageSettings.installPath = s.installPath;
  }
  const st = S.activeManageSettings;
  const v = S.verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);
  const pt = S.playtimeMap.get(st.appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "Oynanmadı";
  const lastPlayedStr = pt?.last_played || "Henüz oynanmadı";

  return `
    <div class="manage-tab-content">
      <!-- 1. Dosyalar & Kurulum -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("folder", 14)} Dosyalar & Kurulum</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#60a5fa">${icon("shield", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Dosyaları Doğrula</div>
                <div class="manage-item-desc">Oyun dosyalarının bütünlüğünü kontrol et ve hasarlı parçaları onar</div>
                <div id="manage-verify-box-container">
                  ${
                    isVerifying && v
                      ? `
                    <div class="verify-box" style="margin-top:8px">
                      <div class="verify-bar">
                        <div id="manage-verify-fill" class="verify-fill" style="width:${v.percent}%"></div>
                      </div>
                      <div class="verify-meta">
                        <span id="manage-verify-count">${esc(v.detail || `${v.current}/${v.total} (%${v.percent})`)}</span>
                        <span id="manage-verify-speed">${esc(v.speed)}</span>
                      </div>
                    </div>`
                      : ""
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${st.appName}" ${isVerifying ? "disabled" : ""}>
                ${isVerifying ? "Doğrulanıyor…" : "Doğrula"}
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("folder", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Kurulum Konumu</div>
                <div id="manage-install-path" class="manage-item-desc" style="word-break:break-all">${esc(s.installPath || st.installPath || "Belirtilmemiş")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-move-game-modal" data-id="${st.appName}" title="Oyun Dosyalarını Başka Bir Diske veya Klasöre Taşı">
                ${icon("hard-drive", 13)} Taşı
              </button>
              <button class="btn ghost small" data-act="epic-open-folder" data-id="${st.appName}">
                ${icon("folder", 13)} Klasörü Aç
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#a78bfa">${icon("monitor", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Masaüstü Kısayolu</div>
                <div class="manage-item-desc">Oyunu masaüstünden tek tıkla doğrudan başlatmak için kısayol ekle</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-create-shortcut" data-id="${st.appName}">
                Kısayol Oluştur
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Kayıt Dosyaları & Bulut -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("cloud", 14)} Kayıt Dosyaları & Bulut</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("cloud", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">EOS Bulut Kayıtları</div>
                <div id="manage-cloud-subtitle" class="manage-item-desc">
                  ${
                    S.manageSyncingSaves
                      ? "Bulut ile eşitleniyor…"
                      : st.lastCloudSync
                        ? `En son eşitleme: ${esc(st.lastCloudSync)}`
                        : "İlerlemeleri Epic Online Services (EOS) bulutuna kaydet"
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="Şimdi Eşitle" ${S.manageSyncingSaves ? "disabled" : ""}>
                ${icon("refresh", 13)} Eşitle
              </button>
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-cloud" ${st.cloudSavesEnabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-item-left">
                <div class="manage-item-icon" style="color:#c084fc">${icon("hard-drive", 18)}</div>
                <div class="manage-item-info">
                  <div class="manage-item-title">Yerel Kayıt Yedekleme (Save Backup)</div>
                  <div class="manage-item-desc">İlerlemenizi korumak için yerel arşiv oluşturun veya geri yükleyin</div>
                </div>
              </div>
              <div class="manage-item-right">
                <button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${st.appName}" title="Yedek Klasörünü Aç">
                  ${icon("folder", 13)} Klasör
                </button>
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${S.isBackingUp ? "disabled" : ""}>
                  ${S.isBackingUp ? "Yedekleniyor…" : "Yedek Al"}
                </button>
              </div>
            </div>
            <div id="manage-backup-list" class="backup-list" style="margin-top:10px">
              ${renderBackupListHtml(st.appName)}
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Başlatma ve Güncellemeler -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("zap", 14)} Başlatma ve Güncellemeler</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#34d399">${icon("refresh", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Otomatik Güncelleme</div>
                <div class="manage-item-desc">Yeni bir güncelleme yayınlandığında otomatik indir</div>
              </div>
            </div>
            <div class="manage-item-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-autoupdate" ${st.autoUpdate ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#f59e0b">${icon("zap", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Öncelikli İndirmeler</div>
                <div class="manage-item-desc">Bu oyunun güncellemelerini indirme kuyruğunda en öne al</div>
              </div>
            </div>
            <div class="manage-item-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-priority" ${st.highPriority ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row" style="flex-direction:column;align-items:stretch">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#fb7185">${icon("terminal", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Başlatma Parametreleri (Launch Arguments)</div>
                <div class="manage-item-desc">Gelişmiş komut satırı parametreleri ekleyin (örn: -dx11, -novid)</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;width:100%">
              <input id="manage-args-input" class="text-input" style="flex:1" placeholder="-dx11 -novid" value="${esc(st.launchParameters || "")}" />
              <button class="btn primary small" data-act="manage-save-args" data-id="${st.appName}">Kaydet</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. Oynama Süresi & İstatistikler -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("clock", 14)} Oynama Süresi & İstatistikler</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("clock", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Toplam Oynama Süresi: <span id="manage-playtime-val" style="color:#38bdf8;font-weight:700">${esc(playtimeStr)}</span></div>
                <div id="manage-playtime-meta" class="manage-item-desc">${pt?.session_count ? `${pt.session_count} oturum kaydedildi • Son: ${esc(lastPlayedStr)}` : "Bu launcher üzerinden henüz oturum kaydedilmedi"}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-edit-playtime" data-id="${st.appName}">
                ${icon("edit", 13)} Süreyi Düzenle
              </button>
            </div>
          </div>

          <div class="manage-info-callout">
            <div class="manage-callout-icon">${icon("info", 16)}</div>
            <div class="manage-callout-text">
              <strong>Epic Games Verileri Neden Otomatik Alınamıyor?</strong>
              <p>
                Epic Games Store, oynama sürelerini sadece kendi sunucularındaki özel telemetri sisteminde depolar ve üçüncü parti istemcilerin (Heroic, GOG Galaxy vb.) erişebileceği bir REST/GraphQL veya OAuth API sağlamaz.
              </p>
              <p>
                Launcher üzerinden oyunu başlattığınızda oturum süreleri yerel olarak kaydedilir. Daha önce Epic Games'te geçirdiğiniz süreyi yukarıdaki "Süreyi Düzenle" butonundan bir kez ekleyerek kaldığınız yerden biriktirmeye devam edebilirsiniz.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. Tehlikeli Bölge -->
      <div class="manage-danger-card">
        <div class="manage-item-left">
          <div class="manage-item-icon" style="color:#ef4444;background:rgba(239,68,68,0.1)">${icon("trash", 18)}</div>
          <div class="manage-item-info">
            <div class="manage-item-title" style="color:#f87171">Oyunu Bilgisayardan Kaldır</div>
            <div class="manage-item-desc">Kurulum dosyaları diskten silinecektir. Kayıt dosyalarınız korunur.</div>
          </div>
        </div>
        <div class="manage-item-right">
          <button class="btn danger small" data-act="epic-uninstall" data-id="${st.appName}">
            ${icon("trash", 13)} Oyunu Kaldır
          </button>
        </div>
      </div>
    </div>
  `;
}

function enrichAchievementsData(appName: string, data: EpicAchievementsData): void {
  const g = rawOf(appName);
  const raw = (g?.achievements || (g?.metadata as any)?.achievements) as any;
  const list = raw?.achievements || (Array.isArray(raw) ? raw : undefined);

  if (Array.isArray(list)) {
    for (const item of list) {
      const meta = (item as any)?.achievement || item;
      if (!meta?.name) continue;
      const target = data.achievements.find((a) => a.name === meta.name);
      if (target) {
        if (meta.hidden) target.hidden = true;
        if (typeof meta.isBase === "boolean") target.is_base = meta.isBase;
        else if (typeof meta.is_base === "boolean") target.is_base = meta.is_base;
        if ((!target.display_name || target.display_name.trim() === "") && (meta.unlockedDisplayName || meta.unlocked_display_name)) {
          target.display_name = meta.unlockedDisplayName || meta.unlocked_display_name || "";
        }
        if ((!target.description || target.description.trim() === "") && (meta.unlockedDescription || meta.unlocked_description)) {
          target.description = meta.unlockedDescription || meta.unlocked_description || "";
        }
        if ((!target.icon_link || target.icon_link.trim() === "") && (meta.unlockedIconLink || meta.unlocked_icon_link)) {
          target.icon_link = meta.unlockedIconLink || meta.unlocked_icon_link || "";
        }
      }
    }
  }
}

function renderDrawerAchievements(s: EpicSummary): string {
  const isPlat = isAppPlatinum(s.appName);
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);

  if (S.loadingAchFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Epic Games Store başarımları yükleniyor…</div>
      </div>`;
  }

  const data = S.loadedAchievements.get(s.appName);
  if (!data) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Başarımlar kontrol ediliyor…</div>
      </div>`;
  }

  if (data.achievements.length === 0) {
    if (partner) {
      return `
        <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
          <div style="color:var(--muted);margin-bottom:8px">${icon("gamepad-2", 32)}</div>
          <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">${esc(partner.name)} Başarımları</div>
          <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 14px">Bu oyunun başarımları doğrudan <strong>${esc(partner.name)}</strong> üzerinden takip edilmektedir.</div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
            <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
            <button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${esc(partner.name)}'i Aç</button>
          </div>
        </div>`;
    }
    return `
      <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:8px">${icon("trophy", 32)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">Başarım Desteği Bulunmuyor</div>
        <div style="font-size:12px;color:var(--muted);max-width:300px;margin:0 auto 14px">Bu oyun için Epic Games Store üzerinde tanımlı başarım bulunmuyor.</div>
        <div style="display:flex;justify-content:center;gap:8px">
          <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
        </div>
      </div>`;
  }

  // Katalog metadatasıyla anında zenginleştir (gizli başarımlar ve ana oyun bayrakları)
  enrichAchievementsData(s.appName, data);

  const baseItems = data.achievements.filter((a) => a.is_base);
  const dlcItems = data.achievements.filter((a) => !a.is_base);
  const hasDlc = dlcItems.length > 0;

  const effectiveUnlocked = isDemo ? data.total_achievements : data.user_unlocked;
  const effectiveXp = isDemo ? data.total_xp : data.user_xp;
  const pct = data.total_achievements > 0 ? Math.round((effectiveUnlocked / data.total_achievements) * 100) : 0;

  const baseTotal = baseItems.length;
  const baseUnlocked = isDemo ? baseTotal : baseItems.filter((a) => a.unlocked).length;

  const dlcTotal = dlcItems.length;
  const dlcUnlocked = isDemo ? dlcTotal : dlcItems.filter((a) => a.unlocked).length;

  // Filtreleme (Arama sorgusu, Durum)
  const query = S.achSearchQuery.trim().toLowerCase();

  const filteredItems = data.achievements.filter((a) => {
    // 1. Durum (Status)
    const isUnlocked = a.unlocked || isDemo;
    if (S.activeAchFilter === "unlocked" && !isUnlocked) return false;
    if (S.activeAchFilter === "locked" && isUnlocked) return false;
    if (S.activeAchFilter === "hidden" && !a.hidden) return false;

    // 2. Arama Sorgusu
    if (query) {
      const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
      const matchDesc = (a.description || "").toLowerCase().includes(query);
      if (!matchTitle && !matchDesc) return false;
    }

    return true;
  });

  // Sıralama (Sort)
  const sortedItems = [...filteredItems].sort((a, b) => {
    if (S.achSortOrder === "rarity") {
      const ra = a.rarity?.percent ?? 100;
      const rb = b.rarity?.percent ?? 100;
      return ra - rb;
    }
    if (S.achSortOrder === "xp") {
      return b.xp - a.xp;
    }
    if (S.achSortOrder === "date") {
      const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
      const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
      return db - da;
    }
    return 0; // varsayılan katalog sırası
  });

  // PlayStation 4-Seviyeli Kupa Sayımı (Trophy Breakdown)
  let platTotal = 0, platUnlocked = 0;
  let goldTotal = 0, goldUnlocked = 0;
  let silverTotal = 0, silverUnlocked = 0;
  let bronzeTotal = 0, bronzeUnlocked = 0;

  for (const a of data.achievements) {
    const t = getAchTier(a);
    const u = a.unlocked || isDemo;
    if (t === "platinum") {
      platTotal++;
      if (u) platUnlocked++;
    } else if (t === "gold") {
      goldTotal++;
      if (u) goldUnlocked++;
    } else if (t === "silver") {
      silverTotal++;
      if (u) silverUnlocked++;
    } else {
      bronzeTotal++;
      if (u) bronzeUnlocked++;
    }
  }

  const showPlat = platTotal > 0 || isPlat || data.is_platinum || ((data.base_achievements ?? 0) > 0);
  const effPlatTotal = platTotal > 0 ? platTotal : (showPlat ? 1 : 0);
  const effPlatUnlocked = platTotal > 0 ? platUnlocked : (isPlat ? 1 : 0);

  // Sayaçlar (Status Chips için)
  const scopedAll = data.achievements;
  const scopedUnlocked = isDemo ? scopedAll.length : scopedAll.filter((a) => a.unlocked).length;
  const scopedLocked = scopedAll.length - scopedUnlocked;
  const scopedHidden = scopedAll.filter((a) => a.hidden).length;

  return `
    <!-- 1. PS5 Kompakt Başarım Özet Çubuğu -->
    <div class="ach-summary-bar ${isPlat ? "platinum" : ""}">
      <div class="ach-summary-left">
        <div class="ach-progress-ring" style="position:relative">
          <svg viewBox="0 0 48 48">
            <circle class="ring-bg" cx="24" cy="24" r="20" />
            <circle class="ring-fill" cx="24" cy="24" r="20"
              stroke-dasharray="${2 * Math.PI * 20}"
              stroke-dashoffset="${2 * Math.PI * 20 * (1 - pct / 100)}" />
          </svg>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#f8fafc;pointer-events:none">${isPlat ? epicPlatinumIcon(16) : `%${pct}`}</span>
        </div>
        <div class="ach-summary-text">
          <span class="ach-summary-count">${effectiveUnlocked} / ${data.total_achievements}</span>
          <span class="ach-summary-sub">${isPlat ? "Platin Kupa Tamamlandı!" : `${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP`}</span>
        </div>
      </div>
      <div class="ach-summary-right">
        ${effPlatTotal > 0 ? `<span class="ach-tier-mini plat ${effPlatUnlocked >= effPlatTotal ? "complete" : ""}" title="Platin">${epicPlatinumIcon(11)} ${effPlatUnlocked}/${effPlatTotal}</span>` : ""}
        ${goldTotal > 0 ? `<span class="ach-tier-mini gold ${goldUnlocked >= goldTotal ? "complete" : ""}" title="Altın">${icon("trophy", 11)} ${goldUnlocked}/${goldTotal}</span>` : ""}
        ${silverTotal > 0 ? `<span class="ach-tier-mini silver ${silverUnlocked >= silverTotal ? "complete" : ""}" title="Gümüş">${icon("trophy", 11)} ${silverUnlocked}/${silverTotal}</span>` : ""}
        ${bronzeTotal > 0 ? `<span class="ach-tier-mini bronze ${bronzeUnlocked >= bronzeTotal ? "complete" : ""}" title="Bronz">${icon("trophy", 11)} ${bronzeUnlocked}/${bronzeTotal}</span>` : ""}
        <div class="ach-summary-tools">
          <button class="ach-tool-btn" data-act="ach-refresh" data-id="${s.appName}" title="Verileri Yeniden Sorgula">${icon("refresh", 13)}</button>
          <button class="ach-tool-btn" data-act="open-store-achievements" data-id="${s.appName}" title="Epic Games Store'da Gör">${icon("external", 13)}</button>
        </div>
      </div>
    </div>

    <!-- 2. Arama & Sıralama Barı -->
    <div class="ach-toolbar">
      <!-- Canlı Arama Kutusu -->
      <div class="ach-search-wrap">
        <span class="ach-search-icon">${icon("search", 13)}</span>
        <input type="text" id="ach-search-input" class="ach-search-field" placeholder="Başarım ara..." value="${esc(S.achSearchQuery)}" autocomplete="off" />
        ${S.achSearchQuery ? `<button class="ach-search-clear" data-act="clear-ach-search" title="Aramayı Temizle">${icon("x", 12)}</button>` : ""}
      </div>

      <!-- Sıralama Seçimi -->
      <div class="ach-sort-wrap">
        <select id="ach-sort-select" class="ach-sort-select" title="Sıralama Düzeni">
          <option value="default" ${S.achSortOrder === "default" ? "selected" : ""}>Varsayılan Sıra</option>
          <option value="rarity" ${S.achSortOrder === "rarity" ? "selected" : ""}>Nadirliğe Göre</option>
          <option value="xp" ${S.achSortOrder === "xp" ? "selected" : ""}>XP'ye Göre</option>
          <option value="date" ${S.achSortOrder === "date" ? "selected" : ""}>Kazanılma Tarihine Göre</option>
        </select>
      </div>
    </div>

    <!-- 3. PlayStation Konsol Tarzı Durum Sekmeleri -->
    <div class="ach-status-strip">
      <button class="ach-status-chip ${S.activeAchFilter === "all" ? "active" : ""}" data-act="ach-filter" data-val="all">
        Tümü <span class="ach-chip-num">${scopedAll.length}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "unlocked" ? "active" : ""}" data-act="ach-filter" data-val="unlocked">
        ${icon("check", 11)} Kazanılanlar <span class="ach-chip-num">${scopedUnlocked}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "locked" ? "active" : ""}" data-act="ach-filter" data-val="locked">
        ${icon("lock", 11)} Kilitliler <span class="ach-chip-num">${scopedLocked}</span>
      </button>
      ${scopedHidden > 0 ? `
      <button class="ach-status-chip ${S.activeAchFilter === "hidden" ? "active" : ""}" data-act="ach-filter" data-val="hidden">
        ${icon("eye", 11)} Gizli <span class="ach-chip-num">${scopedHidden}</span>
      </button>` : ""}
    </div>

    <!-- 4. Gruplandırılmış Başarım Listesi -->
    <div class="ach-list-container" id="ach-list-container">
      ${renderAchievementSections(sortedItems, s, hasDlc, data.achievements)}
    </div>
  `;
}

async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  if (S.loadingAchFor === appName) return;
  S.loadingAchFor = appName;
  if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") {
    openEpicModal(appName, false, false);
  }
  try {
    const data = await epicGetAchievements(appName, forceRefresh);
    S.loadedAchievements.set(appName, data);
    if (!S.epicAchSummaries[appName]) {
      S.epicAchSummaries[appName] = {
        app_name: appName,
        user_unlocked: data.user_unlocked,
        total_achievements: data.total_achievements,
        user_xp: data.user_xp,
        total_xp: data.total_xp,
        is_platinum: data.is_platinum,
        supported: data.total_achievements > 0,
      };
    } else {
      S.epicAchSummaries[appName].user_unlocked = data.user_unlocked;
      S.epicAchSummaries[appName].total_achievements = data.total_achievements;
      S.epicAchSummaries[appName].user_xp = data.user_xp;
      S.epicAchSummaries[appName].total_xp = data.total_xp;
      S.epicAchSummaries[appName].is_platinum = data.is_platinum;
    }
  } catch (e) {
    console.warn("Başarımlar alınamadı veya bu oyun için başarım desteği yok:", e);
    S.loadedAchievements.set(appName, {
      achievements: [],
      hidden: [],
      user_unlocked: 0,
      user_xp: 0,
      total_achievements: 0,
      total_xp: 0,
      is_platinum: false,
    });
  } finally {
    S.loadingAchFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") {
      openEpicModal(appName, false, false);
    }
  }
}

/* ---------- Sistem Gereksinimleri UI ---------- */

function renderDrawerSystemRequirements(s: EpicSummary): string {
  if (S.loadingReqFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Epic Games Store sistem gereksinimleri alınıyor…</div>
      </div>`;
  }

  const data = S.loadedRequirements.get(s.appName);
  if (!data) {
    if (S.loadingReqFor !== s.appName) {
      void fetchAndRenderRequirements(s.appName, s.title);
    }
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Sistem gereksinimleri alınıyor…</div>
      </div>`;
  }

  if (!data.supported || data.systems.length === 0) {
    return `
      <div style="text-align:center;padding:36px 18px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:10px">${icon("cpu", 36)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:6px">Gereksinim Tablosu Bulunamadı</div>
        <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 16px;line-height:1.5">Bu oyun için Epic Games Store üzerinde doğrudan donanım tablosu tanımlanmamış olabilir.</div>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
          <button class="btn play small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} Mağaza Sayfası'na Git</button>
        </div>
      </div>`;
  }

  const hasWin = data.systems.some((sys) => isWinSys(sys.systemType));
  const hasMac = data.systems.some((sys) => isMacSys(sys.systemType));

  const currentSys =
    data.systems.find((sys) =>
      S.activeSystemPlatform === "Windows" ? isWinSys(sys.systemType) : isMacSys(sys.systemType)
    ) || data.systems[0];

  const minItems = currentSys.details.filter((d) => d.minimum && d.minimum.trim() !== "");
  const recItems = currentSys.details.filter((d) => d.recommended && d.recommended.trim() !== "");

  const renderDetailList = (items: SystemDetailItem[], isMin: boolean) => {
    if (items.length === 0) {
      return `<div style="font-size:11.5px;color:var(--muted);padding:8px">Gereksinim belirtilmemiş.</div>`;
    }
    return items
      .map((d) => {
        const val = isMin ? d.minimum : d.recommended;
        if (!val) return "";
        return `
          <div class="sys-req-row">
            <div class="sys-req-label">
              ${getHardwareIcon(d.title)}
              <span>${esc(getHardwareLabel(d.title))}</span>
            </div>
            <div class="sys-req-val">${esc(val)}</div>
          </div>`;
      })
      .join("");
  };

  const languagesHtml =
    data.languages.length > 0
      ? `<div class="sys-req-lang-card">
          <div class="sys-req-lang-head">
            ${icon("globe", 13)}
            <span>Desteklenen Diller</span>
          </div>
          <div class="sys-req-lang-body">${esc(data.languages.join(" • "))}</div>
        </div>`
      : "";

  return `
    <div class="sys-req-container">
      ${
        hasWin && hasMac
          ? `
          <div class="sys-req-platforms">
            <button class="sys-req-plat-pill ${isWinSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Windows">
              ${icon("layers", 13)} Windows (PC)
            </button>
            <button class="sys-req-plat-pill ${isMacSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">
              ${icon("monitor", 13)} macOS
            </button>
          </div>`
          : ""
      }

      <div class="sys-req-cards-grid">
        <div class="sys-req-card min">
          <div class="sys-req-card-head">
            <div class="sys-req-badge min">${icon("cpu", 12)} Minimum Gereksinimler</div>
            <div class="sys-req-hint">Oyunu açıp oynamak için gereken temel donanım</div>
          </div>
          <div class="sys-req-body">
            ${renderDetailList(minItems, true)}
          </div>
        </div>

        ${
          recItems.length > 0
            ? `
          <div class="sys-req-card rec">
            <div class="sys-req-card-head">
              <div class="sys-req-badge rec">${icon("rocket", 12)} Önerilen Gereksinimler</div>
              <div class="sys-req-hint">Yüksek kare hızı ve akıcı grafik deneyimi için</div>
            </div>
            <div class="sys-req-body">
              ${renderDetailList(recItems, false)}
            </div>
          </div>`
            : ""
        }
      </div>

      ${languagesHtml}

      <div class="sys-req-footer">
        <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} Yeniden Sorgula</button>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} Epic Mağazası'nda Aç</button>
      </div>
    </div>`;
}

async function fetchAndRenderRequirements(appName: string, title: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  if (S.loadingReqFor === appName) return;
  S.loadingReqFor = appName;
  try {
    const data = await epicGetSystemRequirements(title, appName, forceRefresh);
    S.loadedRequirements.set(appName, data);

    // Açıklaması olmayan oyunlarda mağaza açıklamasını güncelle
    if (data.shortDescription || data.description) {
      const curSummary = S.epicSummaries.find((x) => x.appName === appName);
      const sDesc = curSummary?.description?.trim();
      const needsDesc = !sDesc || sDesc === "Açıklama yok." || sDesc === curSummary?.title || sDesc.length <= 25;
      if (needsDesc && curSummary) {
        curSummary.description = data.shortDescription || cleanStoreDescription(data.description || "");
      }
    }

    // Modal açıksa ve Genel Bakış (overview) sekmesindeyse, arayüzü DOM üzerinde yerinde güncelle
    if (S.currentModalAppName === appName && S.activeDrawerTab === "overview") {
      const descEl = document.getElementById("hub-desc-text");
      if (descEl && (data.shortDescription || data.description)) {
        descEl.textContent = data.shortDescription || cleanStoreDescription(data.description || "");
      }
      const featuresListEl = document.getElementById("hub-features-list");
      if (featuresListEl) {
        const curSummary = S.epicSummaries.find((x) => x.appName === appName);
        if (curSummary) {
          const g = rawOf(appName);
          const partner = getThirdPartyLauncher(g);
          const antiCheat = getAntiCheat(g);
          featuresListEl.innerHTML = renderGameFeatures(curSummary, g, partner, antiCheat, data);
        }
      }
    }
  } catch (e) {
    console.warn("Sistem gereksinimleri alınamadı:", e);
    S.loadedRequirements.set(appName, {
      supported: false,
      systems: [],
      languages: [],
      appName,
    });
  } finally {
    S.loadingReqFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") {
      openEpicModal(appName, false);
    }
  }
}


async function epicOpenFolder(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const targetPath =
    (S.activeManageSettings?.appName === appName ? S.activeManageSettings.installPath : null) ||
    s?.installPath;
  if (!targetPath) {
    toast("Kurulum klasörü bilinmiyor", "err");
    return;
  }
  try {
    if (isTauri) {
      const msg = await invoke<string>("open_folder", { path: targetPath });
      toast(msg, "ok");
    } else toast(`(demo) ${targetPath}`, "");
  } catch (e) {
    toast(String(e), "err");
  }
}

function closeModal(): void {
  modalRoot.innerHTML = "";
  S.currentModalAppName = null;
  updateGamepadHud(S.gamepadPolling);
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

function closeCustomCoverModal(): void {
  const root = document.getElementById("cover-modal-root");
  if (root) root.innerHTML = "";
}

function openCustomCoverModal(appName: string, initialTarget: "cover" | "hero" = "cover"): void {
  let coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) {
    coverRoot = document.createElement("div");
    coverRoot.id = "cover-modal-root";
    document.body.appendChild(coverRoot);
  }
  S.activeCustomCoverAppName = appName;
  S.activeCoverTarget = initialTarget;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;

  S.sgdbSearchQuery = cleanSteamGridSearchTerm(title);
  S.sgdbAssetType = S.activeCoverTarget === "hero" ? "heroes" : "grids";
  S.sgdbActiveStyle = "";
  S.sgdbSelectedCoverUrl = "";
  S.customCoverActiveTab = S.steamGridApiKey ? "steamgrid" : "url";
  S.sgdbErrorMsg = "";
  S.sgdbCoversList = [];
  S.sgdbGamesList = [];
  S.sgdbSelectedGameId = null;
  S.showModalSgdbInfo = false;

  renderCustomCoverModalFrame(appName);
  renderCustomCoverModalContent(appName);

  if (S.steamGridApiKey && S.sgdbSearchQuery) {
    void searchAndLoadSteamGrid(appName, S.sgdbSearchQuery);
  }
}

function renderCustomCoverModalFrame(appName: string): void {
  const coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) return;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;
  const g = rawOf(appName);
  const devRaw = g ? g.metadata?.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";

  const hasCustomCover = Boolean(S.customCovers[appName]);
  const hasCustomHero = Boolean(S.customHeroes[appName]);
  const isCustomForTarget = S.activeCoverTarget === "hero" ? hasCustomHero : hasCustomCover;

  const currentCoverArt = S.customCovers[appName] || s?.cover || "";
  const currentHeroArt = S.customHeroes[appName] || (s ? epicWideArt(s) : null) || s?.cover || "";
  const activeCurrentImg = S.sgdbSelectedCoverUrl || (S.activeCoverTarget === "hero" ? currentHeroArt : currentCoverArt);
  const hasAnyCustom = hasCustomCover || hasCustomHero;

  coverRoot.innerHTML = `
    <div class="cover-overlay" data-act="cover-modal-backdrop">
      <div class="cover-dialog wide" data-act="prevent-modal-close">
        <div class="cover-dialog-header">
          <div class="cover-dialog-title-group">
            <div class="cover-dialog-icon">${icon("image", 18)}</div>
            <div>
              <h2>Görselleri Özelleştir</h2>
              <div class="cover-dialog-sub">${esc(title)}${dev ? ` • ${esc(dev)}` : ""}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-custom-cover" title="Kapat">${icon("x", 16)}</button>
        </div>

        <div class="cover-dialog-body">
          <!-- Düzenleme Hedefi Segment Kontrolü -->
          <div class="cover-target-segment">
            <button class="target-segment-pill ${S.activeCoverTarget === "cover" ? "active" : ""}" data-act="set-cover-target" data-target="cover" data-id="${appName}">
              ${icon("image", 14)}
              <span>Dikey Kapak (2:3 Kütüphane)</span>
              ${hasCustomCover ? `<span class="target-indicator-dot" title="Özel dikey kapak aktif"></span>` : ""}
            </button>
            <button class="target-segment-pill ${S.activeCoverTarget === "hero" ? "active" : ""}" data-act="set-cover-target" data-target="hero" data-id="${appName}">
              ${icon("rows", 14)}
              <span>Yatay Afiş (Hero / Vitrin)</span>
              ${hasCustomHero ? `<span class="target-indicator-dot" title="Özel yatay afiş aktif"></span>` : ""}
            </button>
          </div>

          <!-- Canlı Önizleme ve Hedef Bilgisi -->
          <div class="cover-preview-section">
            <div class="cover-preview-card ${S.activeCoverTarget === "hero" ? "wide" : "portrait"}">
              ${activeCurrentImg ? `<img id="cover-preview-img" src="${esc(activeCurrentImg)}" alt="Önizleme" />` : `<div id="cover-preview-img" class="cover-preview-empty">${icon("image", 36)}</div>`}
              <div class="cover-preview-badge">${S.sgdbSelectedCoverUrl ? "Seçilen Önizleme" : isCustomForTarget ? "Özel Görsel" : "Orijinal"}</div>
            </div>
            <div class="cover-preview-meta">
              <div class="cover-meta-header">
                <span class="cover-meta-badge ${S.activeCoverTarget}">
                  ${S.activeCoverTarget === "cover" ? `${icon("image", 12)} 2:3 Kütüphane Kartı` : `${icon("rows", 12)} 16:7 Vitrin & Detay Afişi`}
                </span>
                ${isCustomForTarget ? `<span class="cover-status-tag custom">${icon("sparkles", 11)} Özel Görsel Kullanılıyor</span>` : `<span class="cover-status-tag">${icon("check", 11)} Orijinal Epic Görseli</span>`}
              </div>
              <div class="cover-meta-desc">
                ${S.activeCoverTarget === "cover"
                  ? "Kütüphane ızgarasında ve listelerde görünen dikey afiş. SteamGridDB'den beğendiğiniz bir kapak seçebilir veya web bağlantısı yapıştırabilirsiniz."
                  : "Ana sayfadaki öne çıkan vitrinde (Spotlight), detay çekmecesinde ve raflarda arka plan olarak kullanılan sinematik yatay afiş."}
              </div>
              <div class="cover-meta-actions">
                ${isCustomForTarget ? `
                  <button class="btn ghost small danger" data-act="reset-active-target" data-id="${appName}">
                    ${icon("refresh", 12)} ${S.activeCoverTarget === "cover" ? "Dikey Kapağı Sıfırla" : "Yatay Afişi Sıfırla"}
                  </button>
                ` : ""}
              </div>
            </div>
          </div>

          <!-- Kaynak Sekmeleri -->
          <div class="cover-modal-tabs">
            <button class="cover-tab-btn ${S.customCoverActiveTab === "steamgrid" ? "active" : ""}" data-act="switch-cover-tab" data-tab="steamgrid" data-id="${appName}">
              ${icon("globe", 13)} <span>SteamGridDB Topluluğu</span>
            </button>
            <button class="cover-tab-btn ${S.customCoverActiveTab === "url" ? "active" : ""}" data-act="switch-cover-tab" data-tab="url" data-id="${appName}">
              ${icon("external", 13)} <span>Doğrudan Web URL</span>
            </button>
            <button class="cover-tab-btn ${(S.customCoverActiveTab as string) === "file" ? "active" : ""}" data-act="switch-cover-tab" data-tab="file" data-id="${appName}">
              ${icon("folder", 13)} <span>Bilgisayardan Dosya</span>
            </button>
          </div>

          <div id="cover-tab-content-area"></div>
        </div>

        <div class="cover-dialog-footer">
          ${hasAnyCustom ? `
            <button class="btn ghost danger" data-act="reset-all-art" data-id="${appName}" title="Hem dikey kapağı hem yatay afişi orijinal Epic görsellerine döndür">
              ${icon("refresh", 13)} Tümünü Sıfırla
            </button>
          ` : ""}
          <div style="flex:1"></div>
          <button class="btn ghost" data-act="close-custom-cover">Vazgeç</button>
          <button class="btn primary" data-act="save-custom-cover" data-id="${appName}">
            ${icon("check", 14)} ${S.activeCoverTarget === "cover" ? "Dikey Kapağı Kaydet" : "Yatay Afişi Kaydet"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCustomCoverModalContent(appName: string): void {
  const container = document.getElementById("cover-tab-content-area");
  if (!container) return;

  if (S.customCoverActiveTab === "url") {
    const currentVal = S.sgdbSelectedCoverUrl || (S.activeCoverTarget === "hero" ? S.customHeroes[appName] : S.customCovers[appName]) || "";
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-inputs-section">
          <label class="cover-input-label">Görsel Web Bağlantısı (URL)</label>
          <div class="cover-url-row">
            <input id="custom-cover-url-input" class="text-input" placeholder="https://... (Doğrudan görsel linki: .jpg, .png, .webp)" value="${esc(currentVal)}" spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="preview-custom-cover-url" title="Önizle">Önizle</button>
          </div>
          <div class="cover-preview-hint" style="margin-top:4px">
            Doğrudan görsel bağlantısı yapıştırıp <strong>Önizle</strong> butonuna tıklayarak yukarıdaki önizleme kutusunda test edebilirsiniz.
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (S.customCoverActiveTab === "file") {
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-inputs-section">
          <label class="cover-input-label">Bilgisayardan Yerel Dosya Seç</label>
          <label class="cover-file-upload-btn">
            ${icon("folder", 14)} <span>Görsel Dosyası Seç (.png, .jpg, .webp)</span>
            <input id="custom-cover-file-input" type="file" accept="image/*" style="display:none;" />
          </label>
          <div class="cover-preview-hint" style="margin-top:4px">
            Dosya seçtiğinizde görsel yerel olarak işlenerek yukarıdaki önizlemeye anında yansıtılacaktır.
          </div>
        </div>
      </div>
    `;
    return;
  }

  // SteamGridDB Sekmesi
  if (!S.steamGridApiKey) {
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="sgdb-setup-box">
          <div class="sgdb-setup-header">
            <div class="sgdb-setup-icon">${icon("globe", 20)}</div>
            <div>
              <div class="sgdb-setup-title">SteamGridDB Topluluk Entegrasyonu</div>
              <div class="sgdb-setup-desc">
                Video oyunları için topluluk tarafından hazırlanan binlerce dikey kapak (2:3) ve vitrin afişi.
              </div>
            </div>
          </div>

          <div class="sgdb-info-card">
            <div class="sgdb-info-header">
              <div class="sgdb-info-title">
                ${icon("info", 13)}
                <span>SteamGridDB Nedir ve Neden API Anahtarı Gerekir?</span>
              </div>
            </div>
            <div class="sgdb-info-content">
              <p style="margin:0;line-height:1.45">
                SteamGridDB, oyunlar için yüksek kaliteli açık görsel arşividir. Kötüye kullanımı önlemek ve doğrudan kütüphanenizden arama yapabilmek için ücretsiz bir kişisel erişim anahtarı (Token) gereklidir.
              </p>
              <div class="sgdb-info-steps">
                <div class="sgdb-step">
                  <span class="sgdb-step-num">1</span>
                  <span>Resmi SteamGridDB sayfasına gidip giriş yapın (Steam veya Discord ile).</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">2</span>
                  <span>Açılan sayfada <strong>"Create API Key"</strong> butonuna tıklayarak anahtarınızı kopyalayın.</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">3</span>
                  <span>Anahtarı aşağıdaki alana yapıştırıp <strong>"Kaydet ve Ara"</strong> butonuna basın.</span>
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:center;width:100%">
            <button class="btn ghost small sgdb-key-guide-btn" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">
              ${icon("external", 12)} <span>Ücretsiz API Anahtarınızı Buradan Alın</span>
            </button>
          </div>

          <div class="sgdb-setup-input-row">
            <input id="modal-sgdb-key-input" type="${S.showModalSgdbKey ? "text" : "password"}" class="text-input" placeholder="API Anahtarınızı (Token) buraya yapıştırın..." spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="toggle-modal-sgdb-key-visibility" title="Göster/Gizle">${icon(S.showModalSgdbKey ? "eye-off" : "eye", 13)}</button>
            <button class="btn primary small" data-act="save-inline-sgdb-key" data-id="${appName}">Kaydet ve Ara</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="cover-tab-pane">
      <div class="sgdb-container">
        <div class="sgdb-search-bar">
          <input id="sgdb-search-input" class="text-input" placeholder="Oyun adı ara..." value="${esc(S.sgdbSearchQuery)}" spellcheck="false" autocomplete="off" />
          <button class="btn primary small" data-act="sgdb-search" data-id="${appName}" ${S.sgdbIsSearching ? "disabled" : ""}>
            ${S.sgdbIsSearching ? icon("refresh", 12) : icon("search", 12)}
            <span>${S.sgdbIsSearching ? "Aranıyor…" : "Ara"}</span>
          </button>
          <button class="btn ghost small ${S.showModalSgdbInfo ? "active" : ""}" data-act="toggle-sgdb-modal-info" title="SteamGridDB Bilgi">
            ${icon("info", 13)}
          </button>
        </div>

        ${S.showModalSgdbInfo ? `
        <div class="sgdb-info-card compact">
          <div class="sgdb-info-header">
            <div class="sgdb-info-title">${icon("info", 13)} <span>SteamGridDB Topluluk Kütüphanesi</span></div>
            <button data-act="toggle-sgdb-modal-info" title="Kapat">${icon("x", 12)}</button>
          </div>
          <div class="sgdb-info-content">
            <p style="margin:0">SteamGridDB; video oyunları için resmi ve topluluk yapımı dikey kapak (2:3) ve vitrin afişi (Hero) barındıran açık platformdur. Seçtiğiniz görseller kütüphaneniz için anında uygulanır.</p>
            <div style="display:flex;align-items:center;gap:12px;margin-top:2px;font-size:11px;color:#94a3b8">
              <span>Kayıtlı Anahtar: <code>${esc(S.steamGridApiKey.slice(0, 5))}••••••</code></span>
              <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:10.5px;padding:2px 8px">
                ${icon("external", 11)} Anahtarı Yönet
              </button>
            </div>
          </div>
        </div>
        ` : ""}

        ${S.sgdbGamesList.length > 1 ? `
        <div class="sgdb-matching-games-bar">
          <span class="sgdb-matching-label">${icon("gamepad-2", 12)} Oyunlar:</span>
          <div class="sgdb-matching-chips-track">
            ${S.sgdbGamesList.map(g => `
              <button class="sgdb-game-chip ${S.sgdbSelectedGameId === g.id ? "active" : ""}" data-act="sgdb-select-game" data-game-id="${g.id}" data-id="${appName}" title="${esc(g.name)} (ID: ${g.id})">
                ${esc(g.name)}
              </button>
            `).join("")}
          </div>
        </div>` : ""}

        <div class="sgdb-filter-bar">
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${S.sgdbAssetType === "grids" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="grids" data-id="${appName}">
              ${icon("image", 11)} Dikey (2:3)
            </button>
            <button class="sgdb-chip ${S.sgdbAssetType === "heroes" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="heroes" data-id="${appName}">
              ${icon("rows", 11)} Yatay Afiş (Hero)
            </button>
          </div>
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${S.sgdbActiveStyle === "" ? "active" : ""}" data-act="sgdb-set-style" data-style="" data-id="${appName}">Tümü</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "official" ? "active" : ""}" data-act="sgdb-set-style" data-style="official" data-id="${appName}">Resmi</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "no_logo" ? "active" : ""}" data-act="sgdb-set-style" data-style="no_logo" data-id="${appName}">Logosuz</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "alternate" ? "active" : ""}" data-act="sgdb-set-style" data-style="alternate" data-id="${appName}">Alternatif</button>
          </div>
        </div>

        <div class="sgdb-gallery">
          ${S.sgdbIsSearching ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:8px">
              ${icon("refresh", 16)} SteamGridDB üzerinden taranıyor…
            </div>
          ` : S.sgdbErrorMsg ? `
            <div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
              ${esc(S.sgdbErrorMsg)}
            </div>
          ` : S.sgdbCoversList.length === 0 ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">
              Uygun görsel bulunamadı. Farklı bir arama terimi deneyin.
            </div>
          ` : `
            <div class="${S.sgdbAssetType === "heroes" ? "sgdb-grid-horizontal" : "sgdb-grid-vertical"}">
              ${S.sgdbCoversList.map(item => {
                const isSel = S.sgdbSelectedCoverUrl === item.url;
                const thumbUrl = item.thumb || item.url;
                const authorName = item.author?.name || "Topluluk";
                const styleLabel = item.style === "no_logo" ? "Logosuz" : item.style === "alternate" ? "Alternatif" : item.style === "official" ? "Resmi" : "";
                return `
                <div class="sgdb-card ${isSel ? "selected" : ""}" data-act="sgdb-select-card" data-url="${esc(item.url)}" title="${esc(authorName)} • Skor: ${item.score}">
                  <img src="${esc(thumbUrl)}" loading="lazy" alt="Cover" />
                  <div class="sgdb-card-badges">
                    ${styleLabel ? `<span class="sgdb-style-tag">${esc(styleLabel)}</span>` : "<span></span>"}
                    <span class="sgdb-score-tag">▲ ${item.score}</span>
                  </div>
                  <div class="sgdb-card-footer">${esc(authorName)}</div>
                  ${isSel ? `<div class="sgdb-selected-check">${icon("check", 14)}</div>` : ""}
                </div>`;
              }).join("")}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

async function searchAndLoadSteamGrid(appName: string, query?: string): Promise<void> {
  if (!S.steamGridApiKey) {
    renderCustomCoverModalContent(appName);
    return;
  }
  S.sgdbIsSearching = true;
  S.sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);

  const term = query !== undefined ? query.trim() : S.sgdbSearchQuery.trim();
  if (!term) {
    S.sgdbIsSearching = false;
    S.sgdbGamesList = [];
    S.sgdbCoversList = [];
    renderCustomCoverModalContent(appName);
    return;
  }

  try {
    const games = await epicSearchSteamGrid(term);
    S.sgdbGamesList = games;
    if (games.length > 0) {
      S.sgdbSelectedGameId = games[0].id;
      await loadSteamGridCovers(appName, games[0].id);
    } else {
      S.sgdbSelectedGameId = null;
      S.sgdbCoversList = [];
      S.sgdbIsSearching = false;
      renderCustomCoverModalContent(appName);
    }
  } catch (err) {
    S.sgdbErrorMsg = String(err);
    S.sgdbCoversList = [];
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

async function loadSteamGridCovers(appName: string, gameId: number): Promise<void> {
  S.sgdbIsSearching = true;
  S.sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);
  try {
    const covers = await epicGetSteamGridCovers(gameId, S.sgdbAssetType, S.sgdbActiveStyle || undefined);
    S.sgdbCoversList = covers;
  } catch (err) {
    S.sgdbErrorMsg = String(err);
    S.sgdbCoversList = [];
  } finally {
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
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

async function epicInstall(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s || epicDlProgress(appName) !== null) return;
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  if (partner) {
    void epicPlay(appName);
    return;
  }
  S.downloads.set(appName, { progress: 0, done: false, title: s.title });
  if (!S.activeDlMetrics || S.activeDlMetrics.done) {
    S.activeDlMetrics = {
      id: appName,
      title: s.title,
      progress: 0,
      done: false,
      speed: "Başlatılıyor…",
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: "Hesaplanıyor…",
      downloadedBytes: 0,
      totalBytes: s.installSize || 0,
    };
  }
  updateBadge();
  void epicGetQueue().then((q) => {
    S.dlQueueStatus = q;
    if (S.view === "library" || S.view === "downloads") render();
  }).catch(() => {
    if (S.view === "library" || S.view === "downloads") render();
  });
  try {
    const msg = await epicInstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    toast(String(e), "err");
    if (S.view === "library" || S.view === "downloads") render();
  }
}

async function epicCancel(appName: string): Promise<void> {
  try {
    const msg = await epicCancelDownload(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
}

async function epicUninstall(appName: string): Promise<void> {
  try {
    const msg = await epicUninstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
  closeModal();
  await refreshEpicInstalled();
}

async function refreshEpicInstalled(): Promise<void> {
  if (!isTauri) return;
  try {
    const [einstalled, eskipped] = await Promise.all([epicListInstalled(), epicListSkipped()]);
    setEpicSummaries(summarize(S.epicGamesRaw, einstalled, eskipped));
    pruneRecent();
    S.epicSkippedCount = eskipped.length;
    if (S.view === "library") scheduleRender();
    void refreshUpdates();
  } catch (e) {
    toast(`Kurulu listesi tazelenemedi: ${String(e)}`, "err");
  }
}







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
