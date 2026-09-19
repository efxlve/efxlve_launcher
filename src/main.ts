import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  type HltbData,
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
} from "./epic";

/* ---------- Tipler ---------- */

interface Game {
  id: string;
  title: string;
  genre: string;
  price: number; // 0 = ücretsiz
  sizeMb: number;
  version: string;
  installed: boolean;
  installPath?: string | null;
}

interface CatalogMeta {
  description: string;
  gradient: string;
  rating: number;
}

interface ProgressEvent {
  id: string;
  progress: number;
  done: boolean;
}

/* ---------- Sabit katalog (görsel/açıklama bilgileri) ---------- */

const META: Record<string, CatalogMeta> = {
  "anadolu-efsaneleri": {
    description: "Anadolu mitolojisinden ilhamla açık dünya aksiyon RPG. Efsanevi yaratıklarla savaş, antik şehirleri keşfet.",
    gradient: "linear-gradient(135deg,#b33951,#5b2a86)",
    rating: 4.8,
  },
  "neon-surucu": {
    description: "Neon ışıklı sokaklarda yüksek hızlı arcade yarış. 40+ araç, çevrimiçi çok oyunculu mod.",
    gradient: "linear-gradient(135deg,#0abde3,#6c5ce7)",
    rating: 4.5,
  },
  "uzay-madencisi": {
    description: "Uzak gezegenlerde maden kaz, üssünü büyüt, galaksiler arası ticaret yap. Sakin bir uzay simülasyonu.",
    gradient: "linear-gradient(135deg,#1e3799,#0c2461)",
    rating: 4.2,
  },
  "kale-kusatmasi": {
    description: "Orta çağ kuşatma savaşlarında ordunu yönet. Sefer modu ve 4 kişiye kadar co-op.",
    gradient: "linear-gradient(135deg,#e17055,#6d2c1e)",
    rating: 4.7,
  },
  "piksel-ciftligi": {
    description: "Kendi piksel çiftliğini kur, hasat yap, kasabalılarla dost ol. Rahatlatıcı bağımsız yapım.",
    gradient: "linear-gradient(135deg,#00b894,#006266)",
    rating: 4.9,
  },
  "derin-dehlizler": {
    description: "Her seferinde değişen zindanlarda hayatta kal. Zorlu boss'lar, yüzlerce eşya kombinasyonu.",
    gradient: "linear-gradient(135deg,#2d3436,#6c5ce7)",
    rating: 4.4,
  },
};

const FALLBACK_META: CatalogMeta = {
  description: "Açıklama yakında eklenecek.",
  gradient: "linear-gradient(135deg,#2d3436,#636e72)",
  rating: 0,
};

const metaOf = (id: string): CatalogMeta => META[id] ?? FALLBACK_META;

/* ---------- Backend erişimi (Tauri varsa Rust, yoksa tarayıcı-mock) ---------- */

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MOCK_KEY = "efxlve-mock-installed";

function mockInstalled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MOCK_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveMockInstalled(set: Set<string>): void {
  localStorage.setItem(MOCK_KEY, JSON.stringify([...set]));
}

/** Tarayıcıda (vite dev) çalışırken kullanılacak sahte katalog */
function mockCatalog(): Game[] {
  const installed = mockInstalled();
  return [
    { id: "anadolu-efsaneleri", title: "Anadolu Efsaneleri", genre: "RPG", price: 0, sizeMb: 4200, version: "1.4.2", installed: installed.has("anadolu-efsaneleri") },
    { id: "neon-surucu", title: "Neon Sürücü", genre: "Yarış", price: 249, sizeMb: 8100, version: "2.0.1", installed: installed.has("neon-surucu") },
    { id: "uzay-madencisi", title: "Uzay Madencisi", genre: "Simülasyon", price: 149, sizeMb: 2300, version: "0.9.7", installed: installed.has("uzay-madencisi") },
    { id: "kale-kusatmasi", title: "Kale Kuşatması", genre: "Strateji", price: 399, sizeMb: 12500, version: "3.2.0", installed: installed.has("kale-kusatmasi") },
    { id: "piksel-ciftligi", title: "Piksel Çiftliği", genre: "Bağımsız", price: 99, sizeMb: 900, version: "1.1.0", installed: installed.has("piksel-ciftligi") },
    { id: "derin-dehlizler", title: "Derin Dehlizler", genre: "Roguelike", price: 0, sizeMb: 1600, version: "1.0.5", installed: installed.has("derin-dehlizler") },
  ];
}

async function fetchGames(): Promise<Game[]> {
  if (isTauri) return await invoke<Game[]>("list_games");
  await new Promise((r) => setTimeout(r, 200));
  return mockCatalog();
}

/* ---------- Durum ---------- */

let games: Game[] = [];
let view: "library" | "downloads" | "settings" | "dlc-manager" | "profile" = "library";

/* ---------- Epic (Legendary) durumu ---------- */

type EpicPhase = "checking" | "setup" | "login" | "library" | "error";
let epicPhase: EpicPhase = "checking";
let epicBooted = false;
let epicAccount = "";
let epicAccountId: string | null = null;
let lastStoreUrl = EPIC_STORE_URL;
let epicSummaries: EpicSummary[] = [];
let epicSkippedCount = 0;
let epicError = "";
let epicBusy = "";
let setupInfo: SetupStatus | null = null;
let setupProgress: number | null = null;
let setupMessage = "";
let epicBusyMsg = "";
let epicSyncing = false;
let epicSyncNote = "";

/* ---------- Epic kütüphane görünümü (filtre/sıralama/boyut) ---------- */

type EpicFilter = "all" | "installed" | "fav" | "updates" | "platinum";
type EpicSort = "recent" | "alpha" | "installed" | "updates" | "platinum";
type EpicViewMode = "grid" | "shelves" | "list";
type CardSize = "compact" | "normal" | "large";

let epicFilter: EpicFilter = "all";
let epicSort: EpicSort = (localStorage.getItem("efxlve-sort") as EpicSort) || "recent";
let epicViewMode: EpicViewMode = (localStorage.getItem("efxlve-view-mode") as EpicViewMode) || "grid";
let epicCardSize: CardSize = (localStorage.getItem("efxlve-card-size") as CardSize) || "normal";
let epicGamesRaw: EpicGame[] = [];

const sortOptions: { id: EpicSort; label: string; icon: "clock" | "arrow-down-a-z" | "check-circle" | "trophy" | "refresh" }[] = [
  { id: "recent", label: "Son oynanan", icon: "clock" },
  { id: "alpha", label: "Alfabetik", icon: "arrow-down-a-z" },
  { id: "installed", label: "Yüklü önce", icon: "check-circle" },
  { id: "platinum", label: "Platin kupalılar", icon: "trophy" },
  { id: "updates", label: "Güncelleme olanlar", icon: "refresh" },
];

/* ---------- Özel Kapak ve Afiş (Custom Cover & Hero Art) ---------- */
const CUSTOM_COVERS_KEY = "efxlve-custom-covers";
const CUSTOM_HEROES_KEY = "efxlve-custom-heroes";

let customCovers: Record<string, string> = {};
try {
  customCovers = JSON.parse(localStorage.getItem(CUSTOM_COVERS_KEY) ?? "{}");
} catch {
  customCovers = {};
}

let customHeroes: Record<string, string> = {};
try {
  customHeroes = JSON.parse(localStorage.getItem(CUSTOM_HEROES_KEY) ?? "{}");
} catch {
  customHeroes = {};
}

function saveCustomCover(appName: string, url: string): void {
  customCovers[appName] = url.trim();
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(customCovers));
  render();
  if (currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function resetCustomCover(appName: string): void {
  delete customCovers[appName];
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(customCovers));
  render();
  if (currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function saveCustomHero(appName: string, url: string): void {
  customHeroes[appName] = url.trim();
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(customHeroes));
  render();
  if (currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

function resetCustomHero(appName: string): void {
  delete customHeroes[appName];
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(customHeroes));
  render();
  if (currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

/* ---------- SteamGridDB Durum Değişkenleri ---------- */
let steamGridApiKey: string | null = null;
let customCoverActiveTab: "steamgrid" | "url" | "file" = "steamgrid";
let activeCoverTarget: "cover" | "hero" = "cover";
let sgdbSearchQuery = "";
let sgdbAssetType: "grids" | "heroes" = "grids";
let sgdbActiveStyle = "";
let sgdbIsSearching = false;
let sgdbErrorMsg = "";
let sgdbGamesList: SteamGridGame[] = [];
let sgdbSelectedGameId: number | null = null;
let sgdbCoversList: SteamGridImage[] = [];
let sgdbSelectedCoverUrl = "";
let activeCustomCoverAppName = "";
let showSettingsSgdbKey = false;
let showModalSgdbKey = false;
let showModalSgdbInfo = false;

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
let loadedHltb: Map<string, HltbData> = new Map();
let loadingHltbFor: string | null = null;

/* ---------- Koleksiyonlar (Kategoriler) ---------- */
let epicCollections: GameCollection[] = [];
let activeCollectionId: string | null = null; // null = Tümü, "fav" = Favoriler, veya collection.id
let isHeroCollapsed = localStorage.getItem("efxlve-hero-collapsed") === "1";
let isColDropdownOpen = false;

function loadStrSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/* ---------- Başarımlar Durumu ---------- */
let epicAchSummaries: Record<string, EpicAchievementSummary> = {};
const DEMO_PLAT_KEY = "efxlve-demo-platinum";
let demoPlatinumApps: Set<string> = loadStrSet(DEMO_PLAT_KEY);
let loadedAchievements: Map<string, EpicAchievementsData> = new Map();
let loadingAchFor: string | null = null;
type DrawerTab = "overview" | "achievements" | "dlcs" | "manage" | "specs";
let activeDrawerTab: DrawerTab = "overview";
let activeAchScope: "all" | "base" | "dlc" = "all";
let activeAchFilter: "all" | "unlocked" | "locked" | "hidden" = "all";
let achSearchQuery = "";
let achSortOrder: "default" | "rarity" | "xp" | "date" = "default";
const revealedAchievements: Set<string> = new Set();
let currentModalAppName: string | null = null;
let loadedRequirements: Map<string, GameRequirementsResponse> = new Map();
let loadingReqFor: string | null = null;
let activeSystemPlatform: string = "Windows";

/* ---------- Oynama Süresi (Playtime Tracker) & Canlı Oyun Durumu ---------- */
let playtimeMap: Map<string, PlaytimeRecord> = new Map();
const runningGames: Set<string> = new Set();

function fmtPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "Oynanmadı";
  if (seconds < 60) return "< 1 dk";
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  const hours = seconds / 3600;
  return hours >= 10 ? `${Math.round(hours)} sa` : `${hours.toFixed(1)} sa`;
}

/* ---------- Oyuncu Profili Durumu ---------- */
let playerProfileData: EpicPlayerProfile | null = null;
let profileLoading = false;
let profileError = "";
let profileFilter: "all" | "platinum" | "in_progress" | "not_started" = "all";
let profileSort: "progress" | "xp" | "playtime" | "alpha" = "progress";
let profileSearchQuery = "";

/* ---------- Çevrimdışı Mod, Ağ Profili & Yedekleme ---------- */
let offlineMode = false;
let networkProfile: string = "balanced";
const gameBackupsMap: Map<string, SaveBackupInfo[]> = new Map();
let isBackingUp = false;

function updateOfflineModeUi(): void {
  const btn = document.getElementById("btn-offline-mode");
  if (!btn) return;
  if (offlineMode) {
    btn.classList.add("active");
    btn.innerHTML = `${icon("wifi-off", 13)} <span>Çevrimdışı</span>`;
    btn.title = "Çevrimdışı Mod Aktif (Çevrimiçi olmak için tıklayın)";
  } else {
    btn.classList.remove("active");
    btn.innerHTML = `${icon("wifi", 13)} <span>Çevrimiçi</span>`;
    btn.title = "Çevrimiçi Mod Aktif (Çevrimdışı moda geçmek için tıklayın)";
  }
}

function isAppPlatinum(appName: string): boolean {
  return Boolean(demoPlatinumApps.has(appName) || (epicAchSummaries[appName]?.is_platinum));
}

const FAV_KEY = "efxlve-favorites";
const RECENT_KEY = "efxlve-recent";

const epicFav: Set<string> = loadStrSet(FAV_KEY);
let epicRecent: string[] = [...loadStrSet(RECENT_KEY)].slice(0, 8);

function toggleFav(appName: string, triggerBtn?: HTMLElement | null): void {
  const isNowFaved = !epicFav.has(appName);
  if (isNowFaved) epicFav.add(appName);
  else epicFav.delete(appName);
  localStorage.setItem(FAV_KEY, JSON.stringify([...epicFav]));
  render();

  if (triggerBtn) {
    triggerBtn.classList.toggle("faved", isNowFaved);
    triggerBtn.classList.add("heart-burst");
    setTimeout(() => triggerBtn.classList.remove("heart-burst"), 600);
  }

  if (currentModalAppName === appName) {
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
  epicRecent = epicRecent.filter((id) =>
    epicSummaries.some((s) => s.appName === id && s.installed),
  );
  localStorage.setItem(RECENT_KEY, JSON.stringify(epicRecent));
}

function pushRecent(appName: string): void {
  const s = epicSummaries.find((x) => x.appName === appName);
  if (!s || !s.installed) return;
  epicRecent = [appName, ...epicRecent.filter((x) => x !== appName)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(epicRecent));
  updateChrome();
}

function rawOf(appName: string): EpicGame | undefined {
  return epicGamesRaw.find((g) => g.app_name === appName);
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Geniş yatay kapak (Hero banner ve Drawer için) */
function epicWideArt(s: EpicSummary): string | null {
  const customHero = customHeroes[s.appName];
  if (customHero) return customHero;
  const g = rawOf(s.appName);
  const imgs = g?.metadata?.keyImages;
  if (Array.isArray(imgs)) {
    for (const t of [
      "OfferImageWide",
      "DieselStoreFrontWide",
      "DieselGameBox",
      "DieselGameBoxTall",
      "OfferImageTall",
    ]) {
      const found = imgs.find((i) => i?.type === t && typeof i?.url === "string");
      if (found) return found.url;
    }
  }
  return s.cover;
}

/** Üst bar hesap + alt bar son-oynanan göstergesini tazeler. */
function updateChrome(): void {
  const acc = document.getElementById("account");
  if (acc) {
    const name = epicAccount || "Giriş yapılmadı";
    if (acc.textContent !== name || !acc.querySelector("svg")) {
      acc.innerHTML = `<i data-lucide="circle-user-round"></i><span>${esc(name)}</span>`;
      createIcons({ icons: { CircleUserRound } });
    }
    acc.classList.toggle("logged", !!epicAccount);
  }
  const recentEl = document.getElementById("recent");
  if (recentEl) {
    const lastPlayedInstalled = epicRecent.find((id) =>
      epicSummaries.some((x) => x.appName === id && x.installed),
    );
    if (lastPlayedInstalled) {
      const s = epicSummaries.find((x) => x.appName === lastPlayedInstalled);
      recentEl.textContent = `Son: ${s ? s.title : lastPlayedInstalled}`;
    } else {
      recentEl.textContent = "Son: —";
    }
  }
}

/* ---------- Gömülü mağaza (ana pencere içi webview) ---------- */

let storeVisible = false;
let storeMode: "store" | "profile" = "store";
let storeResizeTimer = 0;

function storeRect(): { x: number; y: number; width: number; height: number } {
  const titlebar = document.getElementById("titlebar");
  const statusbar = document.getElementById("statusbar");
  const top = titlebar ? titlebar.offsetHeight : 0;
  const bottom = statusbar ? statusbar.offsetHeight : 0;
  return {
    x: 0,
    y: top,
    width: window.innerWidth,
    height: Math.max(100, window.innerHeight - top - bottom),
  };
}

function syncStoreViewSize(): void {
  if (!storeVisible || !isTauri) return;
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
  closeModal();
  if (storeVisible && lastStoreUrl === url && storeMode === mode) return;
  lastStoreUrl = url;
  storeVisible = true;
  storeMode = mode;
  // Mağaza açılırken modern ve şık yükleme animasyonunu göster
  viewEl.innerHTML = renderStoreLoadingScreen();
  render();
  try {
    await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false });
    window.setTimeout(syncStoreViewSize, 50);
    window.setTimeout(syncStoreViewSize, 200);
  } catch (e) {
    storeVisible = false;
    render();
    toast(String(e), "err");
  }
}

async function loadPlayerProfile(forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  profileLoading = true;
  profileError = "";
  render();
  try {
    playerProfileData = await epicGetPlayerProfile(forceRefresh);
  } catch (e) {
    profileError = String(e);
  } finally {
    profileLoading = false;
    render();
  }
}

async function openProfile(): Promise<void> {
  closeStore();
  view = "profile";
  if (!playerProfileData && !profileLoading) {
    void loadPlayerProfile();
  }
  render();
}

function closeStore(): void {
  if (!storeVisible) return;
  storeVisible = false;
  invoke<string>("hide_store_view").catch((e: unknown) => toast(String(e), "err"));
}

let query = "";
const downloads = new Map<string, { progress: number; done: boolean; title: string }>();
let libraryPath = "—";

const viewEl = document.getElementById("view") as HTMLElement;
const statusEl = document.getElementById("backend-status") as HTMLElement;
const modalRoot = document.getElementById("modal-root") as HTMLElement;
const manageRoot = document.getElementById("manage-root") as HTMLElement;
const selectiveRoot = document.getElementById("selective-root") as HTMLElement;
const playtimeRoot = document.getElementById("playtime-root") as HTMLElement;
const toastsEl = document.getElementById("toasts") as HTMLElement;
const dlBadge = document.getElementById("dl-badge") as HTMLElement;

let activeDlcAppName: string | null = null;
const dlcCache = new Map<string, GameDlcResponse>();
let dlcSearchQuery = "";
let dlcLoading = false;

let selectiveInstallOptions: GameInstallOptions | null = null;
const selectedInstallTags = new Set<string>();
const selectedDlcAppIds = new Set<string>();

const availableUpdates = new Map<string, GameUpdateInfo>();
let prevRenderedUpdatesCount: number = -1;
let prevRenderedColId: string | null | undefined = undefined;
let isSortDropdownOpen = false;
const sortLabelMap: Record<string, string> = {
  recent: "Son oynanan",
  alpha: "Alfabetik",
  installed: "Yüklü önce",
  platinum: "Platin kupalılar",
  updates: "Güncelleme olanlar",
};

const verifyingMap = new Map<string, { current: number; total: number; percent: number; speed: string; detail?: string }>();
let activeManageSettings: GameLocalSettings | null = null;
let manageShowArgs = false;
let manageSyncingSaves = false;

/* ---------- Gelişmiş İndirme & Hız Durumu ---------- */

interface DlMetrics {
  id: string;
  title: string;
  progress: number;
  done: boolean;
  speed: string;
  speedBytes: number;
  diskSpeed: string;
  diskBytes: number;
  eta: string;
  downloadedBytes: number;
  totalBytes: number;
}

let activeDlMetrics: DlMetrics | null = null;
let peakNetSpeedBytes = 0;
const speedHistory: number[] = new Array(60).fill(0);
const diskHistory: number[] = new Array(60).fill(0);
let dlQueueStatus: DlQueueStatus = { isPaused: false, queue: [] };
let speedChartTimer: number | null = null;

function pushSpeedData(netBytes: number, diskBytes: number): void {
  speedHistory.shift();
  speedHistory.push(netBytes);
  diskHistory.shift();
  diskHistory.push(diskBytes);
  if (netBytes > peakNetSpeedBytes) {
    peakNetSpeedBytes = netBytes;
  }
}

function drawSpeedCanvas(): void {
  const canvas = document.getElementById("dl-speed-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || 600;
  const height = rect.height || canvas.clientHeight || 140;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  // Background subtle gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, "#0e1014");
  bgGrad.addColorStop(1, "#090a0d");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Determine scale (max speed in bytes)
  const maxData = Math.max(...speedHistory, ...diskHistory, 1024 * 1024);
  const scaleMax = Math.max(maxData * 1.15, 1024 * 1024);

  // Draw horizontal grid lines (4 lines: 25%, 50%, 75%, 100%)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i <= 3; i++) {
    const y = height - height * (i * 0.25);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    const speedVal = scaleMax * (i * 0.25);
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.setLineDash([]);
    ctx.fillText(`${fmtBytes(speedVal)}/s`, 8, y - 4);
    ctx.setLineDash([4, 4]);
  }
  ctx.setLineDash([]);

  const len = speedHistory.length;
  const step = width / (len - 1);

  const drawSeries = (
    data: number[],
    strokeColor: string,
    glowColor: string,
    gradStart: string,
  ) => {
    if (data.length < 2) return;

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < len; i++) {
      const val = data[i] ?? 0;
      const x = i * step;
      const y = height - (val / scaleMax) * (height - 12) - 6;
      points.push({ x, y: Math.max(6, Math.min(height - 6, y)) });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const mx = (p0.x + p1.x) / 2;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, (p0.y + p1.y) / 2);
    }
    const lastP = points[points.length - 1];
    ctx.lineTo(lastP.x, lastP.y);

    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const areaGrad = ctx.createLinearGradient(0, 0, 0, height);
    areaGrad.addColorStop(0, gradStart);
    areaGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = areaGrad;
    ctx.fill();
  };

  // Disk speed (green)
  drawSeries(diskHistory, "#00d26a", "rgba(0, 210, 106, 0.4)", "rgba(0, 210, 106, 0.12)");

  // Network speed (cyan)
  drawSeries(speedHistory, "#00e5ff", "rgba(0, 229, 255, 0.5)", "rgba(0, 229, 255, 0.18)");
}

function startSpeedChartTimer(): void {
  if (speedChartTimer !== null) return;
  speedChartTimer = window.setInterval(() => {
    if (activeDlMetrics && !activeDlMetrics.done && !dlQueueStatus.isPaused) {
      pushSpeedData(activeDlMetrics.speedBytes || 0, activeDlMetrics.diskBytes || 0);
      if (view === "downloads") drawSpeedCanvas();
    } else if (speedHistory.some((v) => v > 0) || diskHistory.some((v) => v > 0)) {
      pushSpeedData(0, 0);
      if (view === "downloads") drawSpeedCanvas();
    }
  }, 1000);
}

/* ---------- Yardımcılar ---------- */

function toast(msg: string, kind: "ok" | "err" | "" = ""): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (kind === "err") {
    el.title = "Kopyalamak için tıkla";
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const text = el.textContent ?? "";
      const done = (): void => el.remove();
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done);
      else done();
    });
    toastsEl.appendChild(el);
    const errs = toastsEl.querySelectorAll(".toast.err");
    while (errs.length > 3) errs[0]?.remove();
    return;
  }
  toastsEl.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

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

function fmtPrice(p: number): string {
  return p === 0 ? "Ücretsiz" : `₺${p.toFixed(2)}`;
}

function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function gameById(id: string): Game | undefined {
  return games.find((g) => g.id === id);
}

function updateBadge(): void {
  const active = [...downloads.values()].filter((d) => !d.done).length;
  dlBadge.textContent = active > 0 ? String(active) : "";
  dlBadge.classList.toggle("hidden", active === 0);
}

/* ---------- Aksiyonlar ---------- */

async function refreshGames(): Promise<void> {
  try {
    games = await fetchGames();
    statusEl.textContent = isTauri ? "● backend bağlı (Rust)" : "● demo modu (tarayıcı)";
    statusEl.className = isTauri ? "ok" : "mock";
    statusEl.id = "backend-status";
  } catch (e) {
    toast(`Oyun listesi alınamadı: ${String(e)}`, "err");
  }
  render();
}

async function installGame(id: string): Promise<void> {
  const game = gameById(id);
  if (!game || game.installed || downloads.get(id)?.done === false) return;
  downloads.set(id, { progress: 0, done: false, title: game.title });
  updateBadge();
  render();

  try {
    if (isTauri) {
      const msg = await invoke<string>("install_game", { id });
      toast(msg, "ok");
    } else {
      for (let p = 5; p <= 100; p += 5) {
        await new Promise((r) => setTimeout(r, 90));
        downloads.set(id, { progress: p, done: false, title: game.title });
        if (view === "downloads" || view === "library") render();
        updateBadge();
      }
      downloads.set(id, { progress: 100, done: true, title: game.title });
      const set = mockInstalled();
      set.add(id);
      saveMockInstalled(set);
      toast(`${game.title} kuruldu`, "ok");
    }
  } catch (e) {
    downloads.delete(id);
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

function renderDownloads(): string {
  let activeDl = activeDlMetrics && !activeDlMetrics.done ? activeDlMetrics : null;
  if (!activeDl) {
    const activeFromMap = [...downloads.entries()].find(([_, d]) => !d.done);
    if (activeFromMap) {
      activeDl = {
        id: activeFromMap[0],
        title: activeFromMap[1].title,
        progress: activeFromMap[1].progress,
        done: false,
        speed: "—",
        speedBytes: 0,
        diskSpeed: "—",
        diskBytes: 0,
        eta: "Hesaplanıyor…",
        downloadedBytes: 0,
        totalBytes: 0,
      };
    }
  }

  const activeSummary = activeDl ? epicSummaries.find((s) => s.appName === activeDl?.id) : null;
  const activeCover = activeSummary?.cover || "";
  const activeWide = activeSummary ? (epicWideArt(activeSummary) || activeCover) : "";
  const activeTitle = activeSummary?.title || activeDl?.title || activeDl?.id || "";

  const completedEntries = [...downloads.entries()].filter(([_, d]) => d.done);
  const queueApps = dlQueueStatus.queue.filter((appId) => !activeDl || appId !== activeDl.id);

  // Active Hero markup
  let heroMarkup = "";
  if (activeDl) {
    const isPaused = dlQueueStatus.isPaused;
    const pct = Math.round(activeDl.progress);
    heroMarkup = `
      <div class="dl-active-hero">
        ${activeWide ? `<img class="dl-hero-bg" src="${esc(activeWide)}" alt="" />` : ""}
        <div class="dl-hero-content">
          <div class="dl-hero-top">
            <div class="dl-hero-game-info">
              ${activeCover ? `<img class="dl-hero-thumb" src="${esc(activeCover)}" alt="${esc(activeTitle)}" />` : `<div class="dl-hero-thumb"></div>`}
              <div class="dl-hero-details">
                <div class="dl-hero-title">${esc(activeTitle)}</div>
                <div class="dl-hero-badges">
                  ${
                    isPaused
                      ? `<span class="dl-status-tag paused">${icon("pause", 11)} Duraklatıldı</span>`
                      : `<span class="dl-status-tag active">${icon("zap", 11)} İndiriliyor</span>`
                  }
                </div>
              </div>
            </div>
            <div class="dl-hero-actions">
              ${
                isPaused
                  ? `<button class="btn primary small" data-act="dl-resume" data-id="${activeDl.id}">
                      ${icon("play", 13)} Devam Et
                    </button>`
                  : `<button class="btn ghost small" data-act="dl-pause" data-id="${activeDl.id}">
                      ${icon("pause", 13)} Duraklat
                    </button>`
              }
              <button class="btn ghost small" data-act="manage-game" data-id="${activeDl.id}">
                ${icon("settings", 13)} Yönet
              </button>
              <button class="btn danger small" data-act="epic-cancel" data-id="${activeDl.id}">
                İptal Et
              </button>
            </div>
          </div>

          <!-- İlerleme Çubuğu -->
          <div class="dl-hero-progress-section">
            <div class="dl-progress-meta-row">
              <span class="dl-progress-pct" id="dl-hero-pct">%${pct}</span>
              <span id="dl-stat-bytes">${fmtBytes(activeDl.downloadedBytes)} / ${fmtBytes(activeDl.totalBytes)}</span>
            </div>
            <div class="dl-hero-track">
              <div class="dl-hero-fill" id="dl-hero-fill" style="width:${pct}%"></div>
            </div>
          </div>

          <!-- Canlı Metrik Kutuları -->
          <div class="dl-stat-tiles-grid">
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box speed">${icon("download", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">İndirme Hızı</div>
                <div class="dl-stat-value highlight-cyan" id="dl-stat-speed">${activeDl.speed || "0 B/s"}</div>
                <div class="dl-stat-sub">Anlık ağ akışı</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box disk">${icon("hard-drive", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Disk Yazma</div>
                <div class="dl-stat-value highlight-green" id="dl-stat-disk">${activeDl.diskSpeed || "0 B/s"}</div>
                <div class="dl-stat-sub">Diske işlenen</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box eta">${icon("clock", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Kalan Süre (ETA)</div>
                <div class="dl-stat-value" id="dl-stat-eta">${activeDl.eta || "Hesaplanıyor…"}</div>
                <div class="dl-stat-sub">Tahmini bitiş</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box size">${icon("layers", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Toplam Boyut</div>
                <div class="dl-stat-value">${fmtBytes(activeDl.totalBytes)}</div>
                <div class="dl-stat-sub">Paket boyutu</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (queueApps.length === 0 && completedEntries.length === 0) {
    heroMarkup = `
      <div class="dl-active-hero" style="text-align:center;padding:48px 24px;align-items:center;">
        <div style="color:var(--muted);margin-bottom:12px;">${icon("download", 38)}</div>
        <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:6px;">Aktif İndirme Bulunmuyor</div>
        <div class="muted" style="margin-bottom:20px;max-width:420px;font-size:13px;line-height:1.5;">
          Kütüphanenden dilediğin oyunu seçerek indirmeyi başlatabilir, indirme hızını ve disk durumunu buradan canlı takip edebilirsin.
        </div>
        <div>
          <button class="btn primary" data-act="goto-library">Kütüphaneye Git</button>
        </div>
      </div>
    `;
  }

  // Steam-style Speed Chart
  const netLegendVal = activeDl?.speed || (speedHistory[speedHistory.length - 1] > 0 ? `${fmtBytes(speedHistory[speedHistory.length - 1])}/s` : "0 B/s");
  const diskLegendVal = activeDl?.diskSpeed || (diskHistory[diskHistory.length - 1] > 0 ? `${fmtBytes(diskHistory[diskHistory.length - 1])}/s` : "0 B/s");

  const chartMarkup = `
    <div class="dl-chart-card">
      <div class="dl-chart-head">
        <div class="dl-chart-title">
          ${icon("zap", 16)} Canlı Ağ ve Disk Aktivitesi
        </div>
        <div class="dl-chart-legend">
          <div class="dl-legend-item">
            <span class="dl-legend-dot net"></span>
            <span>Ağ Hızı: <strong id="dl-legend-net-val" style="color:#00e5ff">${esc(netLegendVal)}</strong></span>
          </div>
          <div class="dl-legend-item">
            <span class="dl-legend-dot disk"></span>
            <span>Disk Hızı: <strong id="dl-legend-disk-val" style="color:#00d26a">${esc(diskLegendVal)}</strong></span>
          </div>
        </div>
      </div>
      <div class="dl-canvas-container">
        <canvas id="dl-speed-canvas"></canvas>
      </div>
    </div>
  `;

  // Queue Markup
  let queueItemsMarkup = "";
  if (queueApps.length > 0) {
    queueItemsMarkup = queueApps.map((appId, idx) => {
      const s = epicSummaries.find((x) => x.appName === appId);
      const title = s?.title || appId;
      const cover = s?.cover || "";
      const sizeStr = s?.installSize ? `Boyut: ${fmtBytes(s.installSize)}` : "Sıraya alındı";
      const isFirst = idx === 0;
      const isLast = idx === queueApps.length - 1;
      return `
        <div class="dl-queue-row">
          <div class="dl-queue-left">
            <div class="dl-queue-order-badge">#${idx + 1}</div>
            ${cover ? `<img class="dl-queue-thumb" src="${esc(cover)}" alt="${esc(title)}" />` : `<div class="dl-queue-thumb"></div>`}
            <div class="dl-queue-info">
              <div class="dl-queue-name">${esc(title)}</div>
              <div class="dl-queue-meta">${esc(sizeStr)}</div>
            </div>
          </div>
          <div class="dl-queue-right">
            <button class="dl-reorder-btn" data-act="dl-reorder-up" data-id="${appId}" title="Yukarı Taşı" ${isFirst ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-up", 14)}
            </button>
            <button class="dl-reorder-btn" data-act="dl-reorder-down" data-id="${appId}" title="Aşağı Taşı" ${isLast ? "disabled style='opacity:0.3;cursor:not-allowed'" : ""}>
              ${icon("chevron-down", 14)}
            </button>
            <button class="btn primary small" data-act="dl-reorder-now" data-id="${appId}" title="Hemen İndir">
              ${icon("play", 11)} Şimdi İndir
            </button>
            <button class="dl-reorder-btn" data-act="dl-reorder-remove" data-id="${appId}" title="Kuyruktan Çıkar">
              ${icon("x", 14)}
            </button>
          </div>
        </div>
      `;
    }).join("");
  } else {
    queueItemsMarkup = `<div class="muted" style="padding: 16px; background: #14161a; border-radius: 12px; border: 1px solid rgba(255,255,255,0.04); text-align: center; font-size: 13px;">Kuyrukta bekleyen oyun yok.</div>`;
  }

  const queueSection = `
    <div class="dl-section-title">
      <span>Kuyruktaki Oyunlar (${queueApps.length})</span>
    </div>
    <div class="dl-queue-container">
      ${queueItemsMarkup}
    </div>
  `;

  // Completed items
  let completedSection = "";
  if (completedEntries.length > 0) {
    const items = completedEntries.map(([appId, d]) => {
      const s = epicSummaries.find((x) => x.appName === appId);
      const cover = s?.cover || "";
      return `
        <div class="dl-queue-row" style="border-left: 3px solid #00d26a;">
          <div class="dl-queue-left">
            <div class="dl-queue-order-badge" style="color:#00d26a">${icon("check", 12)}</div>
            ${cover ? `<img class="dl-queue-thumb" src="${esc(cover)}" alt="${esc(d.title)}" />` : `<div class="dl-queue-thumb"></div>`}
            <div class="dl-queue-info">
              <div class="dl-queue-name">${esc(d.title)}</div>
              <div class="dl-queue-meta" style="color:#00d26a">Tamamlandı • Oynamaya hazır</div>
            </div>
          </div>
          <div class="dl-queue-right">
            <button class="btn primary small" data-act="play" data-id="${appId}">
              ${icon("play", 12)} Oyna
            </button>
            <button class="btn ghost small" data-act="manage-game" data-id="${appId}">
              ${icon("settings", 12)} Yönet
            </button>
          </div>
        </div>
      `;
    }).join("");

    completedSection = `
      <div class="dl-section-title" style="margin-top: 24px;">
        <span>Son Tamamlananlar (${completedEntries.length})</span>
      </div>
      <div class="dl-queue-container">
        ${items}
      </div>
    `;
  }

  return `
    <div class="dl-hub">
      <div class="dl-header-group">
        <h2>İndirme Yöneticisi</h2>
        <span class="muted" style="font-size:13px">${activeDl ? "1 aktif indirme yürütülüyor" : "Boşta"}</span>
      </div>
      ${heroMarkup}
      ${chartMarkup}
      ${queueSection}
      ${completedSection}
    </div>
  `;
}

/* ---------- Eklenti & DLC Yönetim Sayfası (DLC Manager - Screenshot 2) ---------- */

function renderDlcRows(dlcs: GameDlcItem[]): string {
  if (dlcs.length === 0) {
    return `<div style="padding: 32px 20px; text-align: center; color: var(--muted); font-size: 13px;">
      Kayıtlı eklenti bulunmuyor.
    </div>`;
  }
  return dlcs
    .map((dlc) => {
      const isDownloadable = dlc.downloadable !== false;
      const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : (isDownloadable ? "—" : "Oyuna Dahil");
      const thumbHtml = dlc.image
        ? `<img class="dlc-row-thumb" src="${esc(dlc.image)}" alt="${esc(dlc.title)}" />`
        : `<div class="dlc-row-thumb"></div>`;

      const actionHtml = isDownloadable
        ? `
          <label class="toggle-switch" title="${dlc.installed ? "Kaldır" : "Yükle"}">
            <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(activeDlcAppName!)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        `
        : `
          <span class="dlc-badge-active" title="Hesapta Etkin">${icon("check", 12)} Hesapta Aktif</span>
        `;

      return `
      <div class="dlc-table-row">
        <div class="dlc-row-item">
          ${thumbHtml}
          <div class="dlc-row-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div>
        </div>
        <div class="dlc-row-size">${esc(sizeStr)}</div>
        <div class="dlc-row-toggle">
          ${actionHtml}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderDlcManager(): string {
  if (!activeDlcAppName) {
    return `<div class="empty">Eklenti seçilmedi.</div>`;
  }
  const summary = epicSummaries.find((s) => s.appName === activeDlcAppName);
  const title = summary?.title || activeDlcAppName;
  const dlcRes = dlcCache.get(activeDlcAppName);

  if (dlcLoading && !dlcRes) {
    return `
      <div class="dlc-manager-container">
        <div class="dlc-manager-back" data-act="dlc-back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          Kütüphaneye Geri Dön
        </div>
        <div style="text-align:center;padding:60px 0;">
          <div class="spinner" style="margin:0 auto 16px"></div>
          <div class="muted">Eklentiler taranıyor…</div>
        </div>
      </div>
    `;
  }

  const allDlcs = dlcRes?.dlcs || [];
  const query = dlcSearchQuery.trim().toLowerCase();
  const filteredDlcs = query
    ? allDlcs.filter((d) => d.title.toLowerCase().includes(query))
    : allDlcs;

  return `
    <div class="dlc-manager-container">
      <div class="dlc-manager-back" data-act="dlc-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        Kütüphaneye Geri Dön
      </div>

      <div class="dlc-manager-head-row">
        <h1>${esc(title)} Eklenti</h1>
        <div class="dlc-search-wrapper">
          <svg class="dlc-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="dlc-search" class="dlc-search-input" placeholder="Anahtar Kelimeler" value="${esc(dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
        </div>
      </div>

      <!-- Tanıtım Kartı (Screenshot 2) -->
      <div class="dlc-promo-banner">
        <div class="dlc-promo-left">
          <div class="dlc-promo-icon-box">
            ${icon("layers", 20)}
          </div>
          <div class="dlc-promo-info">
            <div class="dlc-promo-title">Bitmedi, dahası da var</div>
            <div class="dlc-promo-desc">Epic Store'dan daha fazla ${esc(title)} Eklentisi al</div>
          </div>
        </div>
        <button class="btn ghost small" data-act="dlc-discover-store" data-id="${esc(activeDlcAppName!)}">
          Eklentileri Keşfet
        </button>
      </div>

      <!-- Eklenti Listesi Tablosu (Screenshot 2) -->
      <div class="dlc-table-container">
        <div class="dlc-table-header">
          <div></div>
          <div class="right">Boyut</div>
          <div class="right">Yüklü</div>
        </div>
        <div id="dlc-table-body">
          ${renderDlcRows(filteredDlcs)}
        </div>
      </div>
    </div>
  `;
}

/* ---------- Seçici Kurulum (Selective Install - Screenshot 3) ---------- */

async function openSelectiveModal(appName: string): Promise<void> {
  const s = epicSummaries.find((x) => x.appName === appName);
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
    selectiveInstallOptions = opts;
    selectedInstallTags.clear();
    selectedDlcAppIds.clear();
    renderSelectiveModal();
  } catch (_err) {
    void epicInstall(appName);
  }
}

async function applySelectiveInstall(appName: string, tags: string[], dlcs: string[]): Promise<void> {
  const s = epicSummaries.find((x) => x.appName === appName);
  const title = s ? s.title : appName;
  closeSelectiveModal();
  downloads.set(appName, { progress: 0, done: false, title });
  if (!activeDlMetrics || activeDlMetrics.done) {
    activeDlMetrics = {
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
    downloads.delete(appName);
    if (activeDlMetrics?.id === appName) activeDlMetrics = null;
    updateBadge();
    render();
    toast(`Kurulum başlatılamadı: ${String(e)}`, "err");
  }
}

function closeSelectiveModal(): void {
  selectiveInstallOptions = null;
  selectedInstallTags.clear();
  selectedDlcAppIds.clear();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
}

function renderSelectiveModal(): void {
  if (!selectiveRoot || !selectiveInstallOptions) return;
  const opts = selectiveInstallOptions;

  const existingBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  const scrollPos = existingBody ? existingBody.scrollTop : 0;

  const langTags = opts.tags.filter((t) => t.category === "languages");
  const extraTags = opts.tags.filter((t) => t.category === "extras");
  const uninstalledDlcs = opts.dlcs.filter((d) => !d.installed);

  let totalDl = opts.baseDownloadSize || opts.baseSize;
  let totalDisk = opts.baseSize;

  for (const tag of opts.tags) {
    if (selectedInstallTags.has(tag.tag)) {
      totalDl += tag.downloadSize || tag.size;
      totalDisk += tag.size;
    }
  }

  for (const dlc of opts.dlcs) {
    if (selectedDlcAppIds.has(dlc.appId)) {
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
              const isChecked = selectedInstallTags.has(t.tag);
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
              const isChecked = selectedInstallTags.has(t.tag);
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
              const isChecked = selectedDlcAppIds.has(d.appId);
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

function renderSettings(): string {
  return `
    <h2>Ayarlar</h2><p class="subtitle">Launcher yapılandırması</p>
    <div class="settings-box">
      <h3>Epic oturumu</h3>
      <p>${epicAccount ? `Bağlı hesap: <strong>${esc(epicAccount)}</strong>` : "Giriş yapılmadı."}</p>
      ${epicAccount ? `<p><button class="btn danger" data-act="epic-logout">Epic'ten çıkış yap</button></p>` : ""}
      <p class="muted">Atlanan öğeler: ${epicSkippedCount}</p>
    </div>
    <div class="settings-box">
      <h3>Oyun kurulum klasörü</h3>
      <p><input id="epic-install-dir" class="text-input" value="${esc(epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(epicDefaultDir || "varsayılan")}" autocomplete="off" spellcheck="false" /></p>
      <p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost small" data-act="epic-save-install-dir">Kaydet</button>
        <span class="muted">Boş bırakırsan varsayılan kullanılır: <code>${esc(epicDefaultDir || "—")}</code></span>
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("gamepad-2", 16)} Epic Games Launcher Entegrasyonu</h3>
      <p>Bilgisayarınızda Epic Games Launcher tarafından yüklenmiş oyunları otomatik algılar ve efxlve launcher ile eşitler.</p>
      ${
        eglDetectedList.length > 0
          ? `
          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
              <span style="font-size:13px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:6px">
                ${icon("check", 14)} ${eglDetectedList.length} Oyun Algılandı
              </span>
              <button class="btn primary small" data-act="epic-sync-egl" ${eglSyncing ? "disabled" : ""}>
                ${eglSyncing ? "Eşitleniyor…" : "Oyunları Eşitle ve İçe Aktar"}
              </button>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;padding-right:6px">
              ${eglDetectedList
                .map(
                  (g: EglDetectedGame) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);border-radius:8px;font-size:12px">
                  <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:#fff">${esc(g.title)}</span>
                    <span style="color:var(--muted);font-size:11px;opacity:0.8">${esc(g.installPath)}</span>
                  </div>
                  <span style="color:var(--accent);font-size:11px;font-weight:600">${fmtBytes(g.installSize)}</span>
                </div>`
                )
                .join("")}
            </div>
          </div>`
          : `
          <p class="muted" style="margin:10px 0">Epic Games Launcher üzerinde kurulu ek oyun bulunamadı veya EGL klasörü tespit edilemedi.</p>
          <p><button class="btn ghost small" data-act="epic-refresh-egl">${icon("refresh", 12)} Yeniden Tara</button></p>
          `
      }
    </div>
    <div class="settings-box">
      <h3>${icon("folder", 16)} Epic Games Koleksiyonları (Kategoriler)</h3>
      <p>Epic Games Launcher üzerindeki özel kategorilerinizi ("Online", "Hikaye", vb.) içe aktarın veya senkronize edin.</p>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px">
        <span class="muted">${epicCollections.length} koleksiyon kayıtlı</span>
        <button class="btn ghost small" data-act="import-egl-collections">
          ${icon("download", 12)} EGL Koleksiyonlarını İçe Aktar
        </button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("image", 16)} SteamGridDB Entegrasyonu (Topluluk Kapakları)</h3>
      <p>SteamGridDB topluluk platformu üzerinden oyunlarınıza yüksek kaliteli dikey kapaklar (2:3) ve vitrin afişleri (hero) ekleyin.</p>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;flex-wrap:wrap">
        <span class="sgdb-status-badge ${steamGridApiKey ? "connected" : "disconnected"}">
          ${steamGridApiKey ? `${icon("check", 12)} Bağlı` : "Anahtar Tanımlanmadı"}
        </span>
        <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:11px;padding:3px 8px">
          ${icon("external", 11)} Ücretsiz API Anahtarı Al
        </button>
      </div>
      <div style="display:flex;gap:8px;max-width:560px;align-items:center;flex-wrap:wrap">
        <input id="settings-sgdb-key-input" type="${showSettingsSgdbKey ? "text" : "password"}" class="text-input" style="flex:1;min-width:240px" placeholder="SteamGridDB API Anahtarını yapıştırın..." value="${esc(steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
        <button class="btn ghost small" data-act="toggle-sgdb-key-visibility" title="Göster/Gizle">${icon(showSettingsSgdbKey ? "eye-off" : "eye", 13)}</button>
        <button class="btn primary small" data-act="save-sgdb-key">Kaydet</button>
        <button class="btn ghost small" data-act="test-sgdb-key">Test Et</button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("zap", 16)} İndirme Ağ Profili (Bant Genişliği)</h3>
      <p>İndirme sırasında bilgisayarınızın ağ ve işlemci kullanım seviyesini belirleyin.</p>
      <div class="net-profile-pills" style="margin-top:10px">
        <button class="net-profile-btn ${networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">
          ${icon("rocket", 13)} Maksimum Hız (16 Worker)
        </button>
        <button class="net-profile-btn ${networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">
          ${icon("shield-check", 13)} Dengeli (4 Worker - Önerilen)
        </button>
        <button class="net-profile-btn ${networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">
          ${icon("clock", 13)} Eko / Düşük (1 Worker)
        </button>
      </div>
      <p class="muted" style="margin-top:8px">
        ${networkProfile === "max" ? "Tüm internet bant genişliğini ve CPU çekirdeklerini kullanarak en yüksek indirme hızını hedefler." : networkProfile === "low" ? "Arka planda düşük kaynak tüketir, oyun oynarken veya internette gezinirken takılmayı önler." : "Oyun ve günlük kullanımda internetinizi kilitlemeden ideal indirme hızı sunar."}
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("wifi-off", 16)} Çevrimdışı Mod (Offline Mode)</h3>
      <p>İnternet bağlantınız olmadığında veya çevrimdışı kalmak istediğinizde kütüphaneyi yerel önbellekten çalıştırır ve oyunları doğrudan çevrimdışı başlatır.</p>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-offline-mode" ${offlineMode ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-weight:600;color:${offlineMode ? "#fbbf24" : "var(--muted)"}">
          ${offlineMode ? "Çevrimdışı Mod Aktif" : "Çevrimiçi Mod (Standart)"}
        </span>
      </div>
    </div>
    <div class="settings-box">
      <h3>Sistem</h3>
      <p><strong>Backend:</strong> ${isTauri ? "Rust (Tauri)" : "Demo (tarayıcı mock)"}</p>
      <p><strong>Kütüphane klasörü:</strong><br /><code>${esc(libraryPath)}</code></p>
      <p><strong>Sürüm:</strong> 0.1.0</p>
      <p style="margin-top:16px">
        <button class="btn ghost" data-act="reset-demo">Demo verisini sıfırla</button>
      </p>
    </div>`;
}

function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    return `
      <div class="profile-empty-games">
        <div class="profile-empty-icon">${icon("gamepad-2", 36)}</div>
        <h4>Oyun Bulunamadı</h4>
        <p>Seçtiğiniz filtreye veya arama kriterine uygun başarım kaydı bulunmuyor.</p>
      </div>
    `;
  }

  return cardGames
    .map((g, idx) => {
      const isPlat = g.is_platinum || g.unlocked_percent >= 100;
      const pt = playtimeMap.get(g.app_name);
      const playtimeStr = pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : null;
      const s = epicSummaries.find((x) => x.appName === g.app_name);
      const isInstalled = s?.installed ?? false;

      const coverUrl = customCovers[g.app_name] || g.cover || s?.cover || "";
      const fillPercent = Math.min(100, Math.max(0, g.unlocked_percent));

      return `
        <div class="profile-game-card ${isPlat ? "platinum" : ""}" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" style="--pci:${Math.min(idx, 20)}">
          <div class="profile-game-cover-wrap">
            ${
              coverUrl
                ? `<img class="profile-game-cover" src="${esc(coverUrl)}" alt="${esc(g.app_title)}" loading="lazy" />`
                : `<div class="profile-game-cover-empty">${icon("gamepad-2", 32)}</div>`
            }
            ${
              isPlat
                ? `<div class="profile-game-plat-ribbon" title="Platin Kupa Tamamlandı!">${icon("crown", 12)} Platin</div>`
                : ""
            }
          </div>

          <div class="profile-game-info">
            <div class="profile-game-title-row">
              <h3 class="profile-game-title" title="${esc(g.app_title)}">${esc(g.app_title)}</h3>
              <div class="profile-game-pills">
                ${isInstalled ? `<span class="profile-game-tag installed">● Yüklü</span>` : ""}
                ${playtimeStr ? `<span class="profile-game-tag playtime">${icon("clock", 11)} ${playtimeStr}</span>` : ""}
              </div>
            </div>

            <div class="profile-game-progress-wrap">
              <div class="profile-game-progress-labels">
                <span class="profile-game-progress-left">
                  <strong>%${g.unlocked_percent}</strong> • ${g.total_unlocked}/${g.total_achievements} Başarım
                </span>
                <span class="profile-game-progress-right">
                  <strong>${g.total_xp.toLocaleString()}</strong> / ${g.total_product_xp.toLocaleString()} XP
                </span>
              </div>
              <div class="profile-game-progress-track">
                <div
                  class="profile-game-progress-fill ${isPlat ? "plat" : ""}"
                  style="width: ${fillPercent}%"
                ></div>
              </div>
            </div>
          </div>

          <div class="profile-game-action">
            <button class="btn ghost small profile-card-btn" data-act="open-game-from-profile" data-id="${esc(g.app_name)}">
              <span>İncele</span> ${icon("chevron-right", 12)}
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderProfile(): string {
  if (profileLoading && !playerProfileData) {
    return `
      <div class="profile-container">
        <div class="profile-loading-box">
          <div class="profile-spinner"></div>
          <h3>Epic Games Profil Verileri Alınıyor…</h3>
          <p>Başarımlarınız, kazanılan XP'leriniz ve kupa kayıtlarınız yükleniyor.</p>
        </div>
      </div>
    `;
  }

  if (profileError && !playerProfileData) {
    return `
      <div class="profile-container">
        <div class="profile-error-box">
          <div class="profile-error-icon">${icon("info", 32)}</div>
          <h3>Profil Yüklenemedi</h3>
          <p>${esc(profileError)}</p>
          <button class="btn primary" data-act="refresh-profile">${icon("refresh", 14)} Tekrar Dene</button>
        </div>
      </div>
    `;
  }

  const prof = playerProfileData;
  const displayName = prof?.display_name || epicAccount || "Oyuncu";
  const accountId = prof?.account_id || epicAccountId || "";
  const totalXp = prof?.total_xp || 0;
  const totalUnlocked = prof?.total_unlocked || 0;
  const platCount = prof?.platinum_count || 0;

  let totalPlaytimeSec = 0;
  for (const r of playtimeMap.values()) {
    totalPlaytimeSec += r.total_seconds || 0;
  }
  const totalPlaytimeStr = fmtPlaytime(totalPlaytimeSec);
  const totalOwnedGames = epicSummaries.length || games.length;
  const totalInstalledGames = epicSummaries.filter((s) => s.installed).length;

  const allGames = prof?.games || [];

  let filteredGames = allGames.filter((g) => {
    if (profileFilter === "platinum") {
      return g.is_platinum || g.unlocked_percent >= 100;
    }
    if (profileFilter === "in_progress") {
      return g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum;
    }
    if (profileFilter === "not_started") {
      return g.unlocked_percent === 0;
    }
    return true;
  });

  if (profileSearchQuery.trim()) {
    const q = profileSearchQuery.trim().toLowerCase();
    filteredGames = filteredGames.filter(
      (g) => g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q),
    );
  }

  filteredGames.sort((a, b) => {
    if (profileSort === "progress") {
      return b.is_platinum !== a.is_platinum
        ? (b.is_platinum ? 1 : -1)
        : b.unlocked_percent !== a.unlocked_percent
          ? b.unlocked_percent - a.unlocked_percent
          : b.total_xp - a.total_xp;
    }
    if (profileSort === "xp") {
      return b.total_xp - a.total_xp;
    }
    if (profileSort === "playtime") {
      const ptA = playtimeMap.get(a.app_name)?.total_seconds || 0;
      const ptB = playtimeMap.get(b.app_name)?.total_seconds || 0;
      return ptB - ptA;
    }
    if (profileSort === "alpha") {
      return a.app_title.localeCompare(b.app_title, "tr");
    }
    return 0;
  });

  const countAll = allGames.length;
  const countPlat = allGames.filter((g) => g.is_platinum || g.unlocked_percent >= 100).length;
  const countInProgress = allGames.filter(
    (g) => g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum,
  ).length;
  const countNotStarted = allGames.filter((g) => g.unlocked_percent === 0).length;

  const initialLetter = displayName.trim().charAt(0).toUpperCase() || "E";

  return `
    <div class="profile-container">
      <!-- 1. Hero Profil Kartı -->
      <div class="profile-hero-card">
        <div class="profile-hero-left">
          <div class="profile-avatar">
            <span class="profile-avatar-letter">${esc(initialLetter)}</span>
            <div class="profile-avatar-glow"></div>
          </div>
          <div class="profile-hero-meta">
            <div class="profile-name-row">
              <h1 class="profile-display-name">${esc(displayName)}</h1>
              <span class="profile-status-badge ${offlineMode ? "offline" : "online"}">
                <span class="status-dot"></span> ${offlineMode ? "Çevrimdışı Mod" : "Epic Games Bağlı"}
              </span>
            </div>
            <div class="profile-id-row">
              <span class="profile-id-label">Hesap ID:</span>
              <code class="profile-id-code" title="${esc(accountId)}">${esc(accountId)}</code>
              <button class="profile-copy-btn" data-act="copy-account-id" data-val="${esc(accountId)}" title="Hesap ID'sini Kopyala">
                ${icon("copy", 13)}
              </button>
            </div>
          </div>
        </div>
        <div class="profile-hero-actions">
          <button class="btn ghost small profile-refresh-btn ${profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="Profili ve başarımları Epic sunucularından tazele">
            ${icon("refresh", 14)} <span>${profileLoading ? "Tazeleniyor…" : "Profili Yenile"}</span>
          </button>
        </div>
      </div>

      <!-- 2. İstatistik & Kupa Vitrini (5 Kart) -->
      <div class="profile-stats-grid">
        <div class="profile-stat-box xp">
          <div class="profile-stat-icon-wrap">${icon("sparkles", 22)}</div>
          <div class="profile-stat-content">
            <div class="profile-stat-value">${totalXp.toLocaleString()} <span class="profile-stat-unit">XP</span></div>
            <div class="profile-stat-label">Kazanılan Toplam XP</div>
            <div class="profile-stat-sub">Epic Seviyesi & Kupa Puanı</div>
          </div>
        </div>

        <div class="profile-stat-box ach">
          <div class="profile-stat-icon-wrap">${icon("trophy", 22)}</div>
          <div class="profile-stat-content">
            <div class="profile-stat-value">${totalUnlocked.toLocaleString()} <span class="profile-stat-unit">Başarım</span></div>
            <div class="profile-stat-label">Açılan Başarımlar</div>
            <div class="profile-stat-sub">${allGames.filter((g) => g.total_unlocked > 0).length} Farklı Oyunda</div>
          </div>
        </div>

        <div class="profile-stat-box plat">
          <div class="profile-stat-icon-wrap">${icon("crown", 22)}</div>
          <div class="profile-stat-content">
            <div class="profile-stat-value">${platCount} <span class="profile-stat-unit">Platin</span></div>
            <div class="profile-stat-label">Platin Kupalar</div>
            <div class="profile-stat-sub">%100 Tamamlanan Oyunlar</div>
          </div>
        </div>

        <div class="profile-stat-box playtime">
          <div class="profile-stat-icon-wrap">${icon("clock", 22)}</div>
          <div class="profile-stat-content">
            <div class="profile-stat-value">${totalPlaytimeStr}</div>
            <div class="profile-stat-label">Toplam Oynama Süresi</div>
            <div class="profile-stat-sub">Launcher Takip Kaydı</div>
          </div>
        </div>

        <div class="profile-stat-box library">
          <div class="profile-stat-icon-wrap">${icon("gamepad-2", 22)}</div>
          <div class="profile-stat-content">
            <div class="profile-stat-value">${totalOwnedGames} <span class="profile-stat-unit">Oyun</span></div>
            <div class="profile-stat-label">Kütüphane Koleksiyonu</div>
            <div class="profile-stat-sub">${totalInstalledGames} Yüklü Oyun</div>
          </div>
        </div>
      </div>

      <!-- 3. Oyun Başarımları ve İlerleme Bölümü -->
      <div class="profile-games-section">
        <div class="profile-games-header">
          <div class="profile-games-title-group">
            <h2 class="profile-section-title">Oyun Başarımları & İlerleme</h2>
            <span class="profile-section-badge">${filteredGames.length} Oyun</span>
          </div>

          <div class="profile-toolbar">
            <div class="profile-filter-pills">
              <button class="profile-pill ${profileFilter === "all" ? "active" : ""}" data-act="profile-filter" data-val="all">
                Tümü (${countAll})
              </button>
              <button class="profile-pill ${profileFilter === "platinum" ? "active" : ""}" data-act="profile-filter" data-val="platinum">
                ${icon("crown", 12)} Platin (${countPlat})
              </button>
              <button class="profile-pill ${profileFilter === "in_progress" ? "active" : ""}" data-act="profile-filter" data-val="in_progress">
                ⏳ Devam Edenler (${countInProgress})
              </button>
              <button class="profile-pill ${profileFilter === "not_started" ? "active" : ""}" data-act="profile-filter" data-val="not_started">
                Başlanmayanlar (${countNotStarted})
              </button>
            </div>

            <div class="profile-toolbar-right">
              <div class="profile-search-wrap">
                <span class="profile-search-icon">${icon("search", 13)}</span>
                <input
                  type="text"
                  id="profile-search"
                  class="profile-search-input"
                  placeholder="Başarım veya oyun ara…"
                  value="${esc(profileSearchQuery)}"
                />
                ${profileSearchQuery ? `<button class="profile-search-clear" data-act="profile-search-clear">×</button>` : ""}
              </div>

              <div class="profile-sort-select-wrap">
                <select id="profile-sort-select" class="profile-sort-select" data-act="profile-sort-change">
                  <option value="progress" ${profileSort === "progress" ? "selected" : ""}>İlerleme Yüzdesi</option>
                  <option value="xp" ${profileSort === "xp" ? "selected" : ""}>Kazanılan XP</option>
                  <option value="playtime" ${profileSort === "playtime" ? "selected" : ""}>Oynama Süresi</option>
                  <option value="alpha" ${profileSort === "alpha" ? "selected" : ""}>Alfabetik (A-Z)</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div id="profile-games-grid" class="profile-games-grid">
          ${renderProfileGameCards(filteredGames)}
        </div>
      </div>
    </div>
  `;
}

function render(): void {
  document.querySelectorAll("#nav button").forEach((b) => {
    const el = b as HTMLElement;
    const active = storeVisible
      ? el.dataset.act === "open-store"
      : el.dataset.view === view;
    el.classList.toggle("active", active);
  });
  if (storeVisible) {
    viewEl.innerHTML = renderStoreLoadingScreen();
    updateChrome();
    return;
  }
  viewEl.innerHTML =
    view === "library" ? renderEpic()
    : view === "downloads" ? renderDownloads()
    : view === "dlc-manager" ? renderDlcManager()
    : view === "profile" ? renderProfile()
    : renderSettings();
  if (view === "downloads") {
    drawSpeedCanvas();
  }
  updateChrome();
}

/* ---------- Epic (Legendary) ---------- */

async function bootEpic(): Promise<void> {
  if (!isTauri || epicBooted) return;
  epicBooted = true;
  void epicGetSteamGridKey().then((k) => { steamGridApiKey = k; }).catch(() => {});
  await refreshEpic();
}

async function refreshEpic(): Promise<void> {
  if (!isTauri) {
    render();
    return;
  }
  epicPhase = "checking";
  epicError = "";
  epicBusyMsg = "";
  epicSyncNote = "";
  render();
  try {
    setupInfo = await epicSetupStatus();
    if (setupInfo.needsDownload) {
      epicPhase = "setup";
      render();
      return;
    }
    const cached: CachedLibrary = await epicCachedLibrary();
    epicSkippedCount = cached.skipped.length;
    if (!cached.account) {
      epicPhase = "login";
      render();
      return;
    }
    epicAccount = cached.account;
    epicAccountId = cached.accountId;
    epicSummaries = summarize(cached.games, cached.installed, cached.skipped);
    pruneRecent();
    epicGamesRaw = cached.games;
    epicPhase = "library";
    render();
    void loadEpicAchSummaries();
    void loadEpicCollections();
    void refreshUpdates();
    void syncEpicLibrary(false);
  } catch (e) {
    epicPhase = "error";
    epicError = String(e);
    render();
  }
}

async function loadEpicCollections(): Promise<void> {
  if (!isTauri) return;
  try {
    epicCollections = await epicGetCollections();
    if (view === "library") render();
  } catch (e) {
    console.warn("Koleksiyonlar alınamadı:", e);
  }
}

async function loadEpicAchSummaries(): Promise<void> {
  if (!isTauri) return;
  try {
    epicAchSummaries = await epicGetAchievementsSummary();
    if (view === "library") render();
  } catch (e) {
    console.warn("Başarım özetleri alınamadı:", e);
  }
}

async function refreshUpdates(): Promise<void> {
  if (!isTauri) return;
  try {
    const updates = await epicCheckUpdates();
    availableUpdates.clear();
    for (const u of updates) {
      availableUpdates.set(u.appName, u);
    }
    if (availableUpdates.size > 0 && view === "library") {
      render();
    }
  } catch (e) {
    console.warn("Güncelleme denetimi yapılamadı:", e);
  }
}

function fmtAchDate(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

/** Arka plan senkronu */
async function syncEpicLibrary(manual: boolean): Promise<void> {
  if (!isTauri || epicSyncing) return;
  epicSyncing = true;
  if (manual) {
    epicBusyMsg = "Kütüphane senkronize ediliyor…";
    if (view === "library") render();
  }
  try {
    const [egames, einstalled, eskipped] = await Promise.all([
      epicListGames(),
      epicListInstalled(),
      epicListSkipped(),
    ]);
    epicSummaries = summarize(egames, einstalled, eskipped);
    pruneRecent();
    epicGamesRaw = egames;
    epicSkippedCount = eskipped.length;
    epicSyncNote = "";
    epicBusyMsg = "";
    void loadEpicAchSummaries();
    void refreshUpdates();
    if (manual) {
      try {
        epicCollections = await epicImportEglCollections();
      } catch {
        void loadEpicCollections();
      }
      toast("Kütüphane ve koleksiyonlar güncellendi", "ok");
    } else {
      void loadEpicCollections();
    }
  } catch (e) {
    if (isNotAuth(e)) {
      epicPhase = "login";
    } else {
      epicSyncNote = "Çevrimdışı önbellek gösteriliyor — senkron başarısız oldu.";
    }
  } finally {
    epicSyncing = false;
    epicBusyMsg = "";
    if (view === "library") render();
  }
}

async function epicDownload(): Promise<void> {
  if (epicBusy) return;
  epicBusy = "download";
  setupProgress = 0;
  render();
  try {
    await epicEnsureBinary();
    toast("legendary hazır", "ok");
    await refreshEpic();
  } catch (e) {
    toast(`İndirme başarısız: ${String(e)}`, "err");
  } finally {
    epicBusy = "";
    setupProgress = null;
    if (view === "library") render();
  }
}

async function epicDoLogin(code: string): Promise<void> {
  if (!code.trim() || epicBusy) return;
  epicBusy = "login";
  render();
  try {
    epicAccount = await epicLoginWithCode(code);
    toast(`${epicAccount} olarak giriş yapıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Giriş başarısız: ${String(e)}`, "err");
  } finally {
    epicBusy = "";
    if (view === "library") render();
  }
}

async function epicDoImport(): Promise<void> {
  if (epicBusy) return;
  epicBusy = "import";
  render();
  try {
    epicAccount = await epicImportEgl();
    toast(`${epicAccount} oturumu aktarıldı`, "ok");
    await refreshEpic();
  } catch (e) {
    toast(`Aktarma başarısız: ${String(e)}`, "err");
  } finally {
    epicBusy = "";
    if (view === "library") render();
  }
}

async function epicDoLogout(): Promise<void> {
  try {
    const msg = await epicLogout();
    toast(msg, "ok");
  } catch (e) {
    toast(String(e), "err");
  }
  epicAccount = "";
  epicAccountId = null;
  epicSummaries = [];
  epicGamesRaw = [];
  epicSkippedCount = 0;
  await refreshEpic();
}

function epicVisibleSummaries(): EpicSummary[] {
  const q = query.toLocaleLowerCase("tr");
  const activeCol =
    activeCollectionId && activeCollectionId !== "all" && activeCollectionId !== "fav"
      ? epicCollections.find((c) => c.id === activeCollectionId)
      : null;

  const list = epicSummaries.filter((s) => {
    if (activeCollectionId === "fav") {
      if (!epicFav.has(s.appName)) return false;
    } else if (activeCol) {
      const inCollection = activeCol.app_names.some(
        (name) => name.toLowerCase() === s.appName.toLowerCase(),
      );
      if (!inCollection) return false;
    }

    if (epicFilter === "installed" && !s.installed) return false;
    if (epicFilter === "fav" && !epicFav.has(s.appName)) return false;
    if (epicFilter === "updates" && !s.updateAvailable && !availableUpdates.has(s.appName)) return false;
    if (epicFilter === "platinum" && !isAppPlatinum(s.appName)) return false;
    return s.title.toLocaleLowerCase("tr").includes(q);
  });
  const recentIdx = (id: string): number => {
    const isInst = epicSummaries.some((s) => s.appName === id && s.installed);
    if (!isInst) return Number.MAX_SAFE_INTEGER;
    const i = epicRecent.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byTitle = (a: EpicSummary, b: EpicSummary) => a.title.localeCompare(b.title, "tr");
  switch (epicSort) {
    case "alpha":
      return [...list].sort(byTitle);
    case "installed":
      return [...list].sort((a, b) => Number(b.installed) - Number(a.installed) || byTitle(a, b));
    case "updates":
      return [...list].sort(
        (a, b) =>
          Number(b.updateAvailable || availableUpdates.has(b.appName)) -
            Number(a.updateAvailable || availableUpdates.has(a.appName)) ||
          byTitle(a, b),
      );
    case "platinum":
      return [...list].sort(
        (a, b) => Number(isAppPlatinum(b.appName)) - Number(isAppPlatinum(a.appName)) || byTitle(a, b),
      );
    default:
      return [...list].sort((a, b) => recentIdx(a.appName) - recentIdx(b.appName));
  }
}

function epicArt(s: EpicSummary): string {
  const custom = customCovers[s.appName];
  if (custom) return `<img src="${esc(custom)}" alt="" loading="lazy" decoding="async" />`;
  const g = rawOf(s.appName);
  const url = g ? epicPortrait(g) : s.cover;
  if (url) return `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`;
  return `<div class="pcover" style="background:linear-gradient(135deg,#1f202c,#3b3d52);color:#94a3b8">${icon("gamepad-2", 40)}</div>`;
}

function getDailyGame(list: EpicSummary[]): EpicSummary | undefined {
  if (list.length === 0) return undefined;
  // Geniş kapak görseli olan oyunları önceliklendir (vitrin afişi sinematik olsun)
  const candidateList = list.filter((s) => !!(epicWideArt(s) || s.cover));
  const pool = candidateList.length > 0 ? candidateList : list;

  const now = new Date();
  const seedStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const index = hash % pool.length;
  return pool[index];
}

function renderHeroSpotlight(): string {
  if (epicSummaries.length === 0 || isHeroCollapsed || epicViewMode === "shelves") return "";

  // 1. Öncelik: Son oynanmış ve şu an kurulu olan oyun
  const recentPlayed = epicRecent.find((id) =>
    epicSummaries.some((s) => s.appName === id && s.installed),
  );

  let targetName = "";
  let isRecent = false;
  let isDaily = false;

  if (recentPlayed) {
    targetName = recentPlayed;
    isRecent = true;
  } else {
    // 2. Öncelik: Kurulu favori oyun
    const installedFav = epicSummaries.find((s) => s.installed && epicFav.has(s.appName))?.appName;
    if (installedFav) {
      targetName = installedFav;
    } else {
      // 3. Öncelik: Günün Oyunu (Her gün kütüphaneden özel olarak seçilen oyun)
      const daily = getDailyGame(epicSummaries);
      if (daily) {
        targetName = daily.appName;
        isDaily = true;
      } else {
        targetName = epicSummaries[0]?.appName;
      }
    }
  }

  const s = epicSummaries.find((x) => x.appName === targetName);
  if (!s) return "";

  const wideImg = epicWideArt(s) || s.cover;
  const g = rawOf(s.appName);
  const devRaw = g?.metadata?.developer;
  const dev = typeof devRaw === "string" ? devRaw : "Epic Games";

  const p = epicDlProgress(s.appName);
  const partner = getThirdPartyLauncher(g);
  const isRunning = runningGames.has(s.appName);
  const pt = playtimeMap.get(s.appName);
  const primaryBtn =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : isRunning
        ? `<button class="btn primary running" data-id="${s.appName}"><span class="running-dot"></span> Oynanıyor…</button>`
        : s.installed
          ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 15)} Hemen Oyna</button>`
          : partner
            ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 15)} ${esc(partner.name)} ile Başlat</button>`
            : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 15)} Yükle</button>`;

  const heroBadge = isRecent
    ? `${icon("play", 11)} Son Oynanan`
    : isDaily
      ? `${icon("sparkles", 11)} Günün Oyunu`
      : s.installed
        ? `${icon("gamepad-2", 11)} Kurulu Oyun`
        : epicFav.has(s.appName)
          ? `${icon("heart", 11)} Favori`
          : `${icon("star", 11)} Öne Çıkan`;

  return `
    <div class="hero-spotlight">
      ${wideImg ? `<img class="hero-bg" src="${wideImg}" alt="" />` : ""}
      <div class="hero-gradient"></div>
      <div class="hero-content">
        <div class="hero-main">
          <div class="hero-badge">
            ${heroBadge}
          </div>
          <h1 class="hero-title">${esc(s.title)}</h1>
          <div class="hero-meta">
            <span class="hero-dev">${esc(dev)}</span>
            <span class="hero-meta-sep">•</span>
            <span class="hero-ver">v${esc(s.version)}</span>
            ${s.installed && s.installSize ? `<span class="hero-meta-sep">•</span><span class="hero-size">${fmtBytes(s.installSize)}</span>` : ""}
            ${pt && pt.total_seconds > 0 ? `<span class="hero-meta-sep">•</span><span class="hero-playtime">${icon("clock", 12)} ${fmtPlaytime(pt.total_seconds)}</span>` : ""}
          </div>
          <div class="hero-actions">
            ${primaryBtn}
            <button class="btn ghost hero-detail-btn" data-act="epic-detail" data-id="${s.appName}">${icon("dots", 14)} Detaylar</button>
          </div>
        </div>
        ${s.cover ? `
        <div class="hero-showcase-card" data-act="epic-detail" data-id="${s.appName}" title="${esc(s.title)} Detayları">
          <img class="hero-showcase-poster" src="${esc(s.cover)}" alt="${esc(s.title)}" />
          <div class="hero-showcase-overlay">
            <span class="hero-showcase-btn">${icon("dots", 12)} İncele</span>
          </div>
        </div>` : ""}
      </div>
    </div>`;
}

function epicCardPortrait(s: EpicSummary, i: number): string {
  const faved = epicFav.has(s.appName);
  const p = epicDlProgress(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const hasUpdate = s.updateAvailable || availableUpdates.has(s.appName);
  const isRunning = runningGames.has(s.appName);
  const pt = playtimeMap.get(s.appName);
  const badge = isRunning
    ? `<span class="pbadge ready" style="background:rgba(16,185,129,0.2);color:#34d399;border-color:rgba(16,185,129,0.5)"><span class="running-dot"></span>Çalışıyor</span>`
    : hasUpdate
      ? `<span class="pbadge update"><span class="dot"></span>Güncelleme</span>`
      : s.installed
        ? `<span class="pbadge ready"><span class="dot"></span>Yüklü</span>`
        : "";
  const ribbon = isPlat
    ? `<div class="platinum-ribbon">${icon("trophy", 11)} 100% Platin</div>`
    : "";
  const dlBar =
    p !== null
      ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${s.appName}" style="width:${p}%"></div></div>`
      : "";

  const microChips: string[] = [];
  if (pt && pt.total_seconds > 0) {
    microChips.push(`<span class="micro-chip playtime">${icon("clock", 10)} ${fmtPlaytime(pt.total_seconds)}</span>`);
  }
  const achSum = epicAchSummaries[s.appName];
  if (isPlat) {
    microChips.push(`<span class="micro-chip plat">${icon("trophy", 10)} Platin</span>`);
  } else if (achSum && achSum.total_achievements > 0) {
    const pct = Math.round((achSum.user_unlocked / achSum.total_achievements) * 100);
    microChips.push(`<span class="micro-chip ach">${icon("trophy", 10)} %${pct}</span>`);
  }

  return `
    <div class="pcard ${i < 24 ? "enter" : ""} ${isPlat ? "platinum" : ""}" style="${i < 24 ? `--ci:${i};animation-delay:${i * 16}ms;` : "animation:none;"}" data-act="epic-detail" data-id="${s.appName}">
      ${epicArt(s)}
      ${badge}
      ${ribbon}
      <div class="shade"></div>
      <div class="poverlay">
        <div class="top">
          <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favori">${icon("heart", 14)}</button>
          <button class="iconbtn" data-act="open-custom-cover" data-id="${s.appName}" title="Kapağı Özelleştir">${icon("image", 14)}</button>
          <button class="iconbtn" data-act="epic-detail" data-id="${s.appName}" title="Detay">${icon("dots", 14)}</button>
        </div>
        <div class="bottom">
          <div class="ptitle">${esc(s.title)}</div>
          ${microChips.length > 0 ? `<div class="pcard-micro-hud">${microChips.join("")}</div>` : ""}
          ${epicActionButtons(s, "full")}
        </div>
      </div>
      ${dlBar}
    </div>`;
}

function epicRowHtml(s: EpicSummary): string {
  const faved = epicFav.has(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const achSum = epicAchSummaries[s.appName];
  const hasUpdate = s.updateAvailable || availableUpdates.has(s.appName);
  const isRunning = runningGames.has(s.appName);
  const pt = playtimeMap.get(s.appName);
  const runTag = isRunning
    ? ` • <span style="color:#34d399;font-weight:700;display:inline-flex;align-items:center;gap:3px"><span class="running-dot"></span> Çalışıyor</span>`
    : "";
  const ptMeta = pt && pt.total_seconds > 0
    ? ` • <span style="color:#38bdf8;display:inline-flex;align-items:center;gap:3px">${icon("clock", 12)} ${fmtPlaytime(pt.total_seconds)}</span>`
    : "";
  const achMeta = isPlat
    ? ` • <span style="color:#ffd700;font-weight:700;display:inline-flex;align-items:center;gap:3px">${icon("trophy", 12)} Platin</span>`
    : achSum && achSum.total_achievements > 0
      ? ` • <span style="color:#a1a1aa;display:inline-flex;align-items:center;gap:3px">${icon("trophy", 12)} ${achSum.user_unlocked}/${achSum.total_achievements}</span>`
      : "";

  return `
    <div class="prow" data-act="epic-detail" data-id="${s.appName}">
      ${epicArt(s)}
      <div class="grow">
        <h4>${esc(s.title)}</h4>
        <div class="meta">v${esc(s.version)}${s.installedVersion ? ` • kurulu: v${esc(s.installedVersion)}` : ""}${hasUpdate ? ` • <span class="upd">Güncelleme</span>` : ""}${runTag}${ptMeta}${achMeta}</div>
      </div>
      <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favori">${icon("heart", 15)}</button>
      ${epicActionButtons(s, "small")}
    </div>`;
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
  const s = epicSummaries.find((x) => x.appName === appName);
  if (!s) return;
  currentModalAppName = appName;
  if (isInitialOpen) {
    activeDrawerTab = "overview";
    activeAchScope = "all";
    activeAchFilter = "all";
    achSearchQuery = "";
    achSortOrder = "default";
  }
  const prevBody = modalRoot.querySelector(".drawer-body") as HTMLElement | null;
  const prevScroll = !isInitialOpen && prevBody ? prevBody.scrollTop : 0;
  const g = rawOf(appName);
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  const faved = epicFav.has(appName);
  const devRaw = g ? g.metadata.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";
  const p = epicDlProgress(appName);
  const isPlat = isAppPlatinum(appName);
  const achSum = epicAchSummaries[appName];
  const partner = getThirdPartyLauncher(g);
  const antiCheat = getAntiCheat(g);

  const isRunning = runningGames.has(appName);
  const primary =
    p !== null
      ? `<button class="btn full primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : isRunning
        ? `<button class="btn full primary running" data-id="${s.appName}"><span class="running-dot"></span> Oynanıyor…</button>`
        : s.installed
          ? `<button class="btn full play" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} Hemen Oyna</button>`
          : partner
            ? `<button class="btn full play" data-act="epic-play" data-id="${s.appName}">${icon("external", 16)} ${esc(partner.name)} ile Başlat / Yükle</button>`
            : `<button class="btn full primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} Yükle</button>`;

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
    ? `<span class="status-pill plat" style="background:linear-gradient(135deg,#ffd700,#b45309);color:#1a0f00;font-weight:800;border:none">${icon("trophy", 12)} 100% Platin</span>`
    : achSum && achSum.total_achievements > 0
      ? `<span class="status-pill ach" style="color:#fbbf24;border-color:rgba(251,191,36,0.3);background:rgba(245,158,11,0.08)">${icon("trophy", 12)} ${achSum.user_unlocked}/${achSum.total_achievements} Başarım</span>`
      : "";

  const achTabBadge = isPlat
    ? `<span class="drawer-tab-badge plat">${icon("trophy", 11)}</span>`
    : achSum && achSum.total_achievements > 0
      ? `<span class="drawer-tab-badge">(${achSum.user_unlocked})</span>`
      : "";

  const dlcRes = dlcCache.get(s.appName);
  const currentDlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const dlcTabBadge = currentDlcCount > 0
    ? `<span class="drawer-tab-badge">(${currentDlcCount})</span>`
    : "";

  if (activeDrawerTab === "overview" && !loadedHltb.has(appName) && loadingHltbFor !== appName) {
    loadingHltbFor = appName;
    epicGetHltb(s.title, s.appName)
      .then((data) => {
        loadedHltb.set(appName, data);
        loadingHltbFor = null;
        const el = document.getElementById("drawer-hltb-container");
        if (el && currentModalAppName === appName) {
          el.innerHTML = renderHltbCard(data);
        }
      })
      .catch(() => {
        loadingHltbFor = null;
      });
  }

  if (!isInitialOpen) {
    const existingDrawer = modalRoot.querySelector(".drawer") as HTMLElement | null;
    const contentEl = document.getElementById("drawer-tab-content");
    if (existingDrawer && contentEl && currentModalAppName === appName) {
      modalRoot.querySelectorAll(".drawer-tab").forEach((btn) => {
        const el = btn as HTMLElement;
        const isActive = el.dataset.tab === activeDrawerTab;
        el.classList.toggle("active", isActive);
        if (isActive) {
          const container = document.getElementById("drawer-tabs-scrollable");
          if (container) ensureTabVisible(el, container);
        }
      });

      const drawerScroll = existingDrawer.scrollTop;
      const achList = contentEl.querySelector(".ach-list") as HTMLElement | null;
      const achScroll = achList ? achList.scrollTop : 0;

      contentEl.innerHTML =
        activeDrawerTab === "overview"
          ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
          : activeDrawerTab === "achievements"
            ? renderDrawerAchievements(s)
            : activeDrawerTab === "dlcs"
              ? renderDrawerDlcs(s)
              : activeDrawerTab === "manage"
                ? renderDrawerManage(s)
                : renderDrawerSystemRequirements(s);

      if (animateTabContent) {
        contentEl.classList.remove("tab-content-enter");
        void contentEl.offsetWidth;
        contentEl.classList.add("tab-content-enter");
      } else {
        contentEl.classList.remove("tab-content-enter");
      }

      existingDrawer.scrollTop = drawerScroll;
      if (achScroll > 0) {
        const nextAchList = contentEl.querySelector(".ach-list") as HTMLElement | null;
        if (nextAchList) nextAchList.scrollTop = achScroll;
      }

      const achTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="achievements"]');
      if (achTabBtn) {
        achTabBtn.innerHTML = `${icon("trophy", 13)} Başarımlar ${achTabBadge}`;
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
      <div class="drawer" style="${isInitialOpen ? "" : "animation:none"}">
        <button class="drawer-close" data-act="close" title="Kapat">${icon("x", 16)}</button>
        <div class="drawer-cover">
          ${art ? `<img src="${art}" alt="" />` : `<div class="pcover" style="color:#94a3b8">${icon("gamepad-2", 48)}</div>`}
          <div class="drawer-gradient"></div>
          <button class="drawer-cover-edit-btn" data-act="open-custom-cover" data-target="hero" data-id="${s.appName}" title="Afiş ve Kapak Görselini Özelleştir">
            ${icon("image", 14)}
          </button>
        </div>
        <div class="drawer-body">
          <h2 class="drawer-title">${esc(s.title)}</h2>
          <div class="drawer-meta-subline">
            ${dev ? `<span class="meta-subline-item dev">${esc(dev)}</span>` : ""}
            ${dev ? `<span class="meta-subline-dot">•</span>` : ""}
            <span class="meta-subline-item status ${s.installed ? "installed" : ""}">${s.installed ? "Kurulu" : "Kurulu Değil"}</span>
            ${partner ? `<span class="meta-subline-dot">•</span><span class="meta-subline-item partner" title="${esc(partner.name)} başlatıcısı gereklidir">${icon("layers", 12)} ${esc(partner.name)}</span>` : ""}
            ${antiCheat ? `<span class="meta-subline-dot">•</span><span class="meta-subline-item anticheat" title="Hile Koruması: ${esc(antiCheat)}">${icon("shield", 12)} ${esc(antiCheat)}</span>` : ""}
            ${s.updateAvailable ? `<span class="meta-subline-dot">•</span><span class="meta-subline-item warn">${icon("zap", 11)} Güncelleme</span>` : ""}
          </div>

          <div class="drawer-tabs-wrapper">
            <div class="drawer-tabs-fade left">
              <button class="drawer-tabs-arrow left" data-act="drawer-tabs-scroll" data-dir="left" title="Sola kaydır">
                ${icon("chevron-left", 13)}
              </button>
            </div>
            <div class="drawer-tabs" id="drawer-tabs-scrollable">
              <button class="drawer-tab ${activeDrawerTab === "overview" ? "active" : ""}" data-act="drawer-tab" data-tab="overview">
                ${icon("gamepad-2", 13)} Genel Bakış
              </button>
              <button class="drawer-tab ${activeDrawerTab === "achievements" ? "active" : ""}" data-act="drawer-tab" data-tab="achievements" data-id="${appName}">
                ${icon("trophy", 13)} Başarımlar ${achTabBadge}
              </button>
              <button class="drawer-tab ${activeDrawerTab === "dlcs" ? "active" : ""}" data-act="drawer-tab" data-tab="dlcs" data-id="${appName}">
                ${icon("layers", 13)} Eklentiler ${dlcTabBadge}
              </button>
              ${s.installed ? `
              <button class="drawer-tab ${activeDrawerTab === "manage" ? "active" : ""}" data-act="drawer-tab" data-tab="manage" data-id="${appName}">
                ${icon("settings", 13)} Yönet
              </button>` : ""}
              <button class="drawer-tab ${activeDrawerTab === "specs" ? "active" : ""}" data-act="drawer-tab" data-tab="specs" data-id="${appName}">
                ${icon("monitor", 13)} Sistem
              </button>
            </div>
            <div class="drawer-tabs-fade right">
              <button class="drawer-tabs-arrow right" data-act="drawer-tabs-scroll" data-dir="right" title="Sağa kaydır">
                ${icon("chevron-right", 13)}
              </button>
            </div>
          </div>

          <div id="drawer-tab-content" class="${animateTabContent ? "tab-content-enter" : ""}">
            ${
              activeDrawerTab === "overview"
                ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
                : activeDrawerTab === "achievements"
                  ? renderDrawerAchievements(s)
                  : activeDrawerTab === "dlcs"
                    ? renderDrawerDlcs(s)
                    : activeDrawerTab === "manage"
                      ? renderDrawerManage(s)
                      : renderDrawerSystemRequirements(s)
            }
          </div>
        </div>
      </div>
    </div>`;

  if (prevScroll > 0) {
    const nextBody = modalRoot.querySelector(".drawer-body") as HTMLElement | null;
    if (nextBody) nextBody.scrollTop = prevScroll;
  }

  requestAnimationFrame(() => {
    updateDrawerTabArrows();
    const container = document.getElementById("drawer-tabs-scrollable");
    if (container && !(container as any)._hasScrollListener) {
      (container as any)._hasScrollListener = true;
      container.addEventListener("scroll", updateDrawerTabArrows, { passive: true });
    }
  });

  if (!dlcCache.has(appName)) {
    epicGetGameDlcs(appName)
      .then((res) => {
        dlcCache.set(appName, res);
        const cur = epicSummaries.find((x) => x.appName === appName);
        if (cur) cur.dlcCount = res.dlcs.length;
        if (currentModalAppName === appName) {
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
}

function renderHltbCard(hltb?: HltbData, isLoading = false): string {
  if (isLoading) {
    return `
      <div class="drawer-hltb-card loading">
        <div class="hltb-head">
          <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
          <div class="hltb-loading-text"><span class="hltb-spinner"></span> Tahmini süreler aranıyor…</div>
        </div>
      </div>
    `;
  }
  if (!hltb || !hltb.supported || (!hltb.main_story && !hltb.main_extra && !hltb.completionist)) {
    return "";
  }
  return `
    <div class="drawer-hltb-card">
      <div class="hltb-head">
        <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
        <div class="hltb-source">Tahmini Bitiş Süreleri</div>
      </div>
      <div class="hltb-grid">
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_story ? `${hltb.main_story} sa` : "—"}</div>
          <div class="hltb-label">Ana Hikaye</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_extra ? `${hltb.main_extra} sa` : "—"}</div>
          <div class="hltb-label">Ana + Ekstra</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.completionist ? `${hltb.completionist} sa` : "—"}</div>
          <div class="hltb-label">%100 Bitirme</div>
        </div>
      </div>
    </div>
  `;
}

function renderDrawerOverview(
  s: EpicSummary,
  primary: string,
  faved: boolean,
  p: number | null,
  descHtml: string,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
): string {
  const pt = playtimeMap.get(s.appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "Oynanmadı";
  const lastPlayedStr = pt?.last_played || "Henüz oynanmadı";

  const gameCols = epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );

  const achSum = epicAchSummaries[s.appName];
  const isPlat = isAppPlatinum(s.appName);
  const achData = loadedAchievements.get(s.appName);
  let quickAchHtml = "";
  if (achSum && achSum.total_achievements > 0) {
    const pct = Math.round((achSum.user_unlocked / achSum.total_achievements) * 100);
    let miniThumbsHtml = "";
    if (achData) {
      const unlockedList = achData.achievements.filter((a) => a.unlocked || demoPlatinumApps.has(s.appName));
      if (unlockedList.length > 0) {
        miniThumbsHtml = `
          <div class="quick-ach-thumbs-row">
            ${unlockedList.slice(0, 4).map((a) => `
              <img class="quick-ach-mini-thumb" src="${esc(a.icon_link || "")}" alt="${esc(a.display_name)}" title="${esc(a.display_name)}" />
            `).join("")}
          </div>
        `;
      }
    }

    quickAchHtml = `
      <div class="drawer-quick-ach-strip ${isPlat ? "plat" : ""}" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}" title="Tüm başarımları detaylı görüntüle">
        <div class="quick-ach-left">
          <div class="quick-ach-trophy ${isPlat ? "plat" : ""}">${icon("trophy", 16)}</div>
          <div class="quick-ach-info">
            <div class="quick-ach-title-row">
              <span class="quick-ach-label">${isPlat ? "🏆 100% Platin Kupa Tamamlandı!" : "Başarım İlerlemesi"}</span>
              <span class="quick-ach-counts">${achSum.user_unlocked}/${achSum.total_achievements} (%${pct})</span>
            </div>
            <div class="quick-ach-bar">
              <div class="quick-ach-bar-fill ${isPlat ? "plat" : ""}" style="width: ${pct}%"></div>
            </div>
          </div>
        </div>
        <div class="quick-ach-right">
          ${miniThumbsHtml}
          <span class="quick-ach-xp">${achSum.user_xp}/${achSum.total_xp} XP</span>
          <span class="quick-ach-arrow">${icon("chevron-right", 14)}</span>
        </div>
      </div>
    `;
  }

  const dlcRes = dlcCache.get(s.appName);
  const currentDlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;

  let featureStripHtml = "";
  if (!descHtml) {
    featureStripHtml = `
      <div class="drawer-feature-strip">
        <div class="drawer-feature-pill">${icon("layers", 12)} <span>${partner ? esc(partner.name) : "Epic Games"}</span></div>
        ${antiCheat ? `<div class="drawer-feature-pill">${icon("shield", 12)} <span>${esc(antiCheat)}</span></div>` : ""}
        ${currentDlcCount > 0 ? `<button class="drawer-feature-pill clickable" data-act="drawer-tab" data-tab="dlcs" data-id="${s.appName}">${icon("package", 12)} <span>${currentDlcCount} Eklenti / DLC</span></button>` : ""}
        <div class="drawer-feature-pill">${icon("monitor", 12)} <span>Windows (PC)</span></div>
      </div>
    `;
  }

  return `
    <div class="drawer-actions">
      ${primary}
      <div class="drawer-actions-row">
        <button class="btn ghost ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favorilere Ekle / Çıkar">
          ${icon("heart", 14)} <span>${faved ? "Favorilerde" : "Favori"}</span>
        </button>
        <button class="btn ghost" data-act="epic-store-page" data-id="${s.appName}" title="Epic Games Store Sayfasını Aç">
          ${icon("external", 14)} <span>Mağaza</span>
        </button>
        ${s.installed ? `
        <button class="btn ghost" data-act="drawer-tab" data-tab="manage" data-id="${s.appName}" title="Dosyaları ve Ayarları Yönet">
          ${icon("settings", 14)} <span>Yönet</span>
        </button>` : ""}
        ${p !== null ? `<button class="btn danger" data-act="epic-cancel" data-id="${s.appName}">${icon("x", 14)} <span>İptal</span></button>` : ""}
      </div>
    </div>

    <!-- Birleşik Bento Bilgi Şeridi (Quick Info Bar) -->
    <div class="drawer-bento-bar">
      <!-- 1. Oynama Süresi & Son Aktivite -->
      <div class="bento-tile bento-playtime" data-act="open-edit-playtime" data-id="${s.appName}" title="Oynama süresini düzenlemek için tıklayın">
        <div class="bento-icon-col">${icon("clock", 16)}</div>
        <div class="bento-info">
          <div class="bento-label">
            <span>Oynama Süresi</span>
            <span class="bento-edit-hint">${icon("edit", 10)}</span>
          </div>
          <div class="bento-val" id="drawer-stat-playtime">${esc(playtimeStr)}</div>
          <div class="bento-sub" id="drawer-stat-last-activity">${esc(lastPlayedStr)}</div>
        </div>
      </div>

      <!-- 2. Koleksiyonlar -->
      <div class="bento-tile bento-collections">
        <div class="bento-icon-col">${icon("folder", 16)}</div>
        <div class="bento-info">
          <div class="bento-label-row">
            <span class="bento-label">Koleksiyon</span>
            <button class="bento-add-btn drawer-col-edit-btn" data-act="manage-game-collections" data-id="${s.appName}" title="Koleksiyonları Yönet">
              ${icon("edit", 11)} <span>${gameCols.length > 0 ? "Düzenle" : "+ Ekle"}</span>
            </button>
          </div>
          <div class="bento-chips-wrap" id="drawer-col-chips-container">
            ${gameCols.length > 0 ? gameCols.map((c) => `
              <button class="bento-col-pill drawer-col-pill" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(c.name)} koleksiyonunu kütüphanede göster">
                ${c.emoji ? `<span class="col-pill-emoji">${esc(c.emoji)}</span>` : `<span class="col-pill-dot"></span>`}
                <span class="col-pill-text">${esc(c.name)}</span>
              </button>
            `).join("") : `
              <button class="bento-empty-col" data-act="manage-game-collections" data-id="${s.appName}">
                <span>Kategori atanmadı</span>
              </button>
            `}
          </div>
          <div id="drawer-col-subtitle" style="display:none">${gameCols.length > 0 ? `${gameCols.length} kategoride ekli` : "Kategori atanmadı"}</div>
        </div>
      </div>
    </div>

    <!-- HowLongToBeat Süreleri -->
    <div id="drawer-hltb-container">
      ${renderHltbCard(loadedHltb.get(s.appName), loadingHltbFor === s.appName)}
    </div>

    <!-- Başarım Hızlı İlerleme Şeridi -->
    ${quickAchHtml}

    ${descHtml}
    ${featureStripHtml}
  `;
}

function renderDrawerDlcs(s: EpicSummary): string {
  const dlcRes = dlcCache.get(s.appName);
  if (dlcLoading && !dlcRes) {
    return `
      <div style="text-align:center;padding:50px 0;">
        <div class="spinner" style="margin:0 auto 16px"></div>
        <div class="muted">Eklentiler taranıyor…</div>
      </div>
    `;
  }
  const allDlcs = dlcRes?.dlcs || [];
  const query = dlcSearchQuery.trim().toLowerCase();
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
        <input id="dlc-drawer-search" placeholder="Eklentiler arasında ara…" value="${esc(dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
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
  if (!activeManageSettings || activeManageSettings.appName !== s.appName) {
    activeManageSettings = {
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
      if (activeManageSettings?.appName === s.appName) {
        activeManageSettings = st;
        updateManageModalInputsInPlace(st);
      }
    }).catch(() => {});
  }
  const st = activeManageSettings;
  const v = verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);
  const pt = playtimeMap.get(st.appName);
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
                <div id="manage-install-path" class="manage-item-desc" style="word-break:break-all">${esc(st.installPath || s.installPath || "Belirtilmemiş")}</div>
              </div>
            </div>
            <div class="manage-item-right">
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
                    manageSyncingSaves
                      ? "Bulut ile eşitleniyor…"
                      : st.lastCloudSync
                        ? `En son eşitleme: ${esc(st.lastCloudSync)}`
                        : "İlerlemeleri Epic Online Services (EOS) bulutuna kaydet"
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="Şimdi Eşitle" ${manageSyncingSaves ? "disabled" : ""}>
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
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${isBackingUp ? "disabled" : ""}>
                  ${isBackingUp ? "Yedekleniyor…" : "Yedek Al"}
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
  const isDemo = demoPlatinumApps.has(s.appName);
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);

  if (loadingAchFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Epic Games Store başarımları yükleniyor…</div>
      </div>`;
  }

  const data = loadedAchievements.get(s.appName);
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

  // Filtreleme (Arama sorgusu, Kapsam, Durum)
  const query = achSearchQuery.trim().toLowerCase();

  const filteredItems = data.achievements.filter((a) => {
    // 1. Kapsam (Scope)
    if (activeAchScope === "base" && !a.is_base) return false;
    if (activeAchScope === "dlc" && a.is_base) return false;

    // 2. Durum (Status)
    const isUnlocked = a.unlocked || isDemo;
    if (activeAchFilter === "unlocked" && !isUnlocked) return false;
    if (activeAchFilter === "locked" && isUnlocked) return false;
    if (activeAchFilter === "hidden" && !a.hidden) return false;

    // 3. Arama Sorgusu
    if (query) {
      const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
      const matchDesc = (a.description || "").toLowerCase().includes(query);
      if (!matchTitle && !matchDesc) return false;
    }

    return true;
  });

  // Sıralama (Sort)
  const sortedItems = [...filteredItems].sort((a, b) => {
    if (achSortOrder === "rarity") {
      const ra = a.rarity?.percent ?? 100;
      const rb = b.rarity?.percent ?? 100;
      return ra - rb;
    }
    if (achSortOrder === "xp") {
      return b.xp - a.xp;
    }
    if (achSortOrder === "date") {
      const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
      const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
      return db - da;
    }
    return 0; // varsayılan katalog sırası
  });

  // Sayaçlar (Status Chips için)
  const scopedAll = data.achievements.filter((a) => {
    if (activeAchScope === "base") return a.is_base;
    if (activeAchScope === "dlc") return !a.is_base;
    return true;
  });
  const scopedUnlocked = isDemo ? scopedAll.length : scopedAll.filter((a) => a.unlocked).length;
  const scopedLocked = scopedAll.length - scopedUnlocked;
  const scopedHidden = scopedAll.filter((a) => a.hidden).length;

  return `
    <!-- 1. SteamHunters Tarzı Sinematik Hero Başlık -->
    <div class="ach-sh-hero ${isPlat ? "platinum" : ""}">
      <div class="ach-sh-hero-body">
        <div class="ach-sh-trophy-col">
          <div class="ach-sh-trophy-badge ${isPlat ? "platinum" : ""}">
            ${icon("trophy", 24)}
          </div>
        </div>
        <div class="ach-sh-info-col">
          <div class="ach-sh-headline-row">
            <h3 class="ach-sh-title">${isPlat ? "100% Platin Kupa!" : "Başarım İlerlemesi"}</h3>
            <span class="ach-sh-pct-pill ${isPlat ? "platinum" : ""}">${isPlat ? "%100" : `%${pct}`}</span>
          </div>
          <div class="ach-sh-stats-row">
            <span class="ach-sh-stat-main"><strong>${effectiveUnlocked}</strong> / ${data.total_achievements} Kupa Kazanıldı</span>
            <span class="ach-sh-stat-dot">•</span>
            <span class="ach-sh-stat-xp"><strong>${effectiveXp.toLocaleString()}</strong> / ${data.total_xp.toLocaleString()} XP</span>
          </div>
          <!-- İlerleme Çubuğu -->
          <div class="ach-sh-bar-wrap">
            <div class="ach-sh-bar">
              <div class="ach-sh-bar-fill ${isPlat ? "gold" : ""}" style="width: ${pct}%"></div>
            </div>
          </div>
          ${hasDlc ? `
          <div class="ach-sh-dual-stats">
            <span class="dual-stat">${icon("gamepad-2", 11)} Ana Oyun: <strong>${baseUnlocked}/${baseTotal}</strong> (%${Math.round(baseUnlocked/baseTotal*100)})</span>
            <span class="dual-stat-sep">•</span>
            <span class="dual-stat">${icon("package", 11)} Ek Paketler: <strong>${dlcUnlocked}/${dlcTotal}</strong> (%${Math.round(dlcUnlocked/dlcTotal*100)})</span>
          </div>
          ` : ""}
        </div>
        <div class="ach-sh-tools-col">
          <button class="ach-sh-tool-btn" data-act="ach-refresh" data-id="${s.appName}" title="Verileri Yeniden Sorgula">${icon("refresh", 13)}</button>
          <button class="ach-sh-tool-btn" data-act="open-store-achievements" data-id="${s.appName}" title="Epic Games Store'da Gör">${icon("external", 13)}</button>
        </div>
      </div>
    </div>

    <!-- 2. Arama & Filtre & Sıralama Barı -->
    <div class="ach-toolbar">
      <!-- Canlı Arama Kutusu -->
      <div class="ach-search-wrap">
        <span class="ach-search-icon">${icon("search", 13)}</span>
        <input type="text" id="ach-search-input" class="ach-search-field" placeholder="Başarım ara..." value="${esc(achSearchQuery)}" autocomplete="off" />
        ${achSearchQuery ? `<button class="ach-search-clear" data-act="clear-ach-search" title="Aramayı Temizle">${icon("x", 12)}</button>` : ""}
      </div>

      <!-- Sıralama Seçimi -->
      <div class="ach-sort-wrap">
        <select id="ach-sort-select" class="ach-sort-select" title="Sıralama Düzeni">
          <option value="default" ${achSortOrder === "default" ? "selected" : ""}>Varsayılan Sıra</option>
          <option value="rarity" ${achSortOrder === "rarity" ? "selected" : ""}>Nadirliğe Göre</option>
          <option value="xp" ${achSortOrder === "xp" ? "selected" : ""}>XP'ye Göre</option>
          <option value="date" ${achSortOrder === "date" ? "selected" : ""}>Kazanılma Tarihine Göre</option>
        </select>
      </div>
    </div>

    <!-- 3. Kapsam (DLC / Ana Oyun) & Durum Sekmeleri -->
    <div class="ach-filter-row">
      ${hasDlc ? `
      <div class="ach-scope-strip">
        <button class="ach-scope-pill ${activeAchScope === "all" ? "active" : ""}" data-act="ach-scope" data-val="all">
          Tüm İçerik <span class="ach-pill-num">${data.achievements.length}</span>
        </button>
        <button class="ach-scope-pill ${activeAchScope === "base" ? "active" : ""}" data-act="ach-scope" data-val="base">
          ${icon("gamepad-2", 11)} Ana Oyun <span class="ach-pill-num">${baseUnlocked}/${baseTotal}</span>
        </button>
        <button class="ach-scope-pill ${activeAchScope === "dlc" ? "active" : ""}" data-act="ach-scope" data-val="dlc">
          ${icon("package", 11)} Ek Paketler <span class="ach-pill-num">${dlcUnlocked}/${dlcTotal}</span>
        </button>
      </div>` : ""}

      <div class="ach-status-strip">
        <button class="ach-status-chip ${activeAchFilter === "all" ? "active" : ""}" data-act="ach-filter" data-val="all">
          Tümü <span class="ach-chip-num">${scopedAll.length}</span>
        </button>
        <button class="ach-status-chip ${activeAchFilter === "unlocked" ? "active" : ""}" data-act="ach-filter" data-val="unlocked">
          ${icon("check", 11)} Kazanılanlar <span class="ach-chip-num">${scopedUnlocked}</span>
        </button>
        <button class="ach-status-chip ${activeAchFilter === "locked" ? "active" : ""}" data-act="ach-filter" data-val="locked">
          ${icon("lock", 11)} Kilitliler <span class="ach-chip-num">${scopedLocked}</span>
        </button>
        ${scopedHidden > 0 ? `
        <button class="ach-status-chip ${activeAchFilter === "hidden" ? "active" : ""}" data-act="ach-filter" data-val="hidden">
          ${icon("eye", 11)} Gizli <span class="ach-chip-num">${scopedHidden}</span>
        </button>` : ""}
      </div>
    </div>

    <!-- 4. SteamHunters Gruplandırılmış Başarım Listesi -->
    <div class="ach-list-container" id="ach-list-container">
      ${renderAchievementSections(sortedItems, s, hasDlc && activeAchScope === "all")}
    </div>
  `;
}

function renderAchievementSections(
  items: EpicAchievementItem[],
  s: EpicSummary,
  shouldGroup: boolean,
): string {
  if (items.length === 0) {
    return `
      <div class="ach-empty-state">
        <div class="ach-empty-state-icon">${icon("search", 28)}</div>
        <div class="ach-empty-state-title">Aramanıza Uygun Başarım Bulunamadı</div>
        <div class="ach-empty-state-sub">Filtreleri veya arama terimini değiştirerek tekrar deneyin.</div>
      </div>
    `;
  }

  const isDemo = demoPlatinumApps.has(s.appName);

  if (!shouldGroup) {
    return `<div class="ach-cards-grid">${items.map((a) => renderAchievementCard(a, s)).join("")}</div>`;
  }

  // SteamHunters Kategori Grupları: Ana Oyun ve Ek Paketler
  const baseItems = items.filter((a) => a.is_base);
  const dlcItems = items.filter((a) => !a.is_base);

  const baseTotal = baseItems.length;
  const baseUnlocked = baseItems.filter((a) => a.unlocked || isDemo).length;
  const basePct = baseTotal > 0 ? Math.round((baseUnlocked / baseTotal) * 100) : 0;
  const baseXp = baseItems.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  const dlcTotal = dlcItems.length;
  const dlcUnlocked = dlcItems.filter((a) => a.unlocked || isDemo).length;
  const dlcPct = dlcTotal > 0 ? Math.round((dlcUnlocked / dlcTotal) * 100) : 0;
  const dlcXp = dlcItems.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  let html = "";

  if (baseItems.length > 0) {
    html += `
      <div class="ach-group-section">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("gamepad-2", 14)}</span>
            <span class="ach-group-heading">Ana Oyun</span>
            <span class="ach-group-badge ${baseUnlocked === baseTotal ? "complete" : ""}">${baseUnlocked}/${baseTotal} (%${basePct})</span>
          </div>
          <div class="ach-group-xp">${baseXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill gold" style="width: ${basePct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${baseItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  if (dlcItems.length > 0) {
    html += `
      <div class="ach-group-section dlc">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("package", 14)}</span>
            <span class="ach-group-heading">Ek Paketler & DLC</span>
            <span class="ach-group-badge ${dlcUnlocked === dlcTotal ? "complete" : ""}">${dlcUnlocked}/${dlcTotal} (%${dlcPct})</span>
          </div>
          <div class="ach-group-xp">${dlcXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill purple" style="width: ${dlcPct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${dlcItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  return html;
}

function renderAchievementCard(a: EpicAchievementItem, s: EpicSummary): string {
  const isDemo = demoPlatinumApps.has(s.appName);
  const isUnlocked = a.unlocked || isDemo;
  const isHidden = a.hidden;
  const isSecretMasked = isHidden && !isUnlocked;
  const isRevealed = revealedAchievements.has(`${s.appName}:${a.name}`);

  const title = isSecretMasked && !isRevealed ? "Gizli Başarım" : (a.display_name || a.name);
  const desc = isSecretMasked && !isRevealed
    ? "Bu başarım gizlidir. Spoiler'ı görmek için tıklayın."
    : (a.description || "Açıklama yok.");
  const tierClass = a.tier?.name ? a.tier.name.toLowerCase() : "";
  const tierIcon = icon("trophy", 11);
  const tierName = fmtTierName(a.tier?.name || "bronze");

  return `
    <div class="ach-card ${isUnlocked ? "unlocked" : "locked"} ${isSecretMasked ? (isRevealed ? "revealed-secret" : "hidden-secret") : ""}"
         ${isSecretMasked ? `data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" role="button" tabindex="0" title="${isRevealed ? "Tekrar gizle" : "Ayrıntıları gör"}"` : ""}>
      
      <!-- Sol: 52px İkon -->
      <div class="ach-icon-wrapper">
        ${
          isSecretMasked && !isRevealed
            ? `<div class="ach-mystery-box">${icon("lock", 20)}</div>`
            : a.icon_link
              ? `<img class="ach-art" src="${esc(a.icon_link)}" alt="" loading="lazy" />`
              : `<div class="ach-fallback-icon">${icon("trophy", 20)}</div>`
        }
        ${!isUnlocked && (!isSecretMasked || isRevealed) ? `<div class="ach-locked-badge">${icon("lock", 12)}</div>` : ""}
      </div>

      <!-- Orta: Başlık & Açıklama & Meta -->
      <div class="ach-content">
        <div class="ach-title-row">
          <span class="ach-name">${isSecretMasked && !isRevealed ? icon("lock", 11) + " " : ""}${esc(title)}</span>
          ${
            isSecretMasked
              ? (isRevealed
                  ? `<button class="ach-reveal-btn revealed" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı tekrar gizle">${icon("eye-off", 10)} Gizle</button>`
                  : `<button class="ach-reveal-btn" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı göster">${icon("eye", 10)} Göster</button>`)
              : isHidden && isUnlocked
                ? `<span class="ach-pill secret">${icon("lock", 9)} Gizli</span>`
                : ""
          }
          ${!a.is_base ? `<span class="ach-pill dlc">${icon("package", 9)} DLC</span>` : ""}
        </div>

        <p class="ach-description">${esc(desc)}</p>

        <div class="ach-meta-row">
          <span class="ach-pill tier ${tierClass}">${tierIcon} ${esc(tierName)}</span>
          ${a.unlock_date && isUnlocked ? `<span class="ach-pill date">${icon("clock", 10)} ${fmtAchDate(a.unlock_date)}</span>` : ""}
          ${a.rarity?.percent != null ? `
            <span class="ach-pill rarity ${a.rarity.percent < 10 ? "ultra-rare" : ""}">
              ${a.rarity.percent < 10 ? icon("sparkles", 10) + " " : ""}%${a.rarity.percent.toFixed(1)} ${a.rarity.percent < 10 ? "Nadir" : ""}
            </span>` : ""}
        </div>
      </div>

      <!-- Sağ: XP & Durum -->
      <div class="ach-aside">
        <div class="ach-xp-chip ${isUnlocked ? "unlocked" : "locked"}">+${a.xp} XP</div>
        ${isUnlocked
          ? `<div class="ach-status-icon earned" title="Kazanıldı">${icon("check", 13)}</div>`
          : `<div class="ach-status-icon locked" title="Kilitli">${icon("lock", 12)}</div>`
        }
      </div>
    </div>
  `;
}

function fmtTierName(name: string): string {
  const n = name.toLowerCase().trim();
  if (n === "bronze") return "Bronz";
  if (n === "silver") return "Gümüş";
  if (n === "gold") return "Altın";
  if (n === "platinum") return "Platin";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  if (loadingAchFor === appName) return;
  loadingAchFor = appName;
  if (currentModalAppName === appName && activeDrawerTab === "achievements") {
    openEpicModal(appName, false, false);
  }
  try {
    const data = await epicGetAchievements(appName, forceRefresh);
    loadedAchievements.set(appName, data);
    if (!epicAchSummaries[appName]) {
      epicAchSummaries[appName] = {
        app_name: appName,
        user_unlocked: data.user_unlocked,
        total_achievements: data.total_achievements,
        user_xp: data.user_xp,
        total_xp: data.total_xp,
        is_platinum: data.is_platinum,
        supported: data.total_achievements > 0,
      };
    } else {
      epicAchSummaries[appName].user_unlocked = data.user_unlocked;
      epicAchSummaries[appName].total_achievements = data.total_achievements;
      epicAchSummaries[appName].user_xp = data.user_xp;
      epicAchSummaries[appName].total_xp = data.total_xp;
      epicAchSummaries[appName].is_platinum = data.is_platinum;
    }
  } catch (e) {
    console.warn("Başarımlar alınamadı veya bu oyun için başarım desteği yok:", e);
    loadedAchievements.set(appName, {
      achievements: [],
      hidden: [],
      user_unlocked: 0,
      user_xp: 0,
      total_achievements: 0,
      total_xp: 0,
      is_platinum: false,
    });
  } finally {
    loadingAchFor = null;
    if (currentModalAppName === appName && activeDrawerTab === "achievements") {
      openEpicModal(appName, false, false);
    }
  }
}

/* ---------- Sistem Gereksinimleri UI ---------- */

function getHardwareIcon(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("os") || t.includes("işletim") || t.includes("windows") || t.includes("system")) return icon("layers", 13);
  if (t.includes("processor") || t.includes("işlemci") || t.includes("cpu")) return icon("cpu", 13);
  if (t.includes("memory") || t.includes("bellek") || t.includes("ram")) return icon("server", 13);
  if (t.includes("storage") || t.includes("depolama") || t.includes("disk") || t.includes("hdd") || t.includes("ssd") || t.includes("space")) return icon("hard-drive", 13);
  if (t.includes("graphics") || t.includes("ekran") || t.includes("gpu") || t.includes("video") || t.includes("direct")) return icon("monitor", 13);
  if (t.includes("sound") || t.includes("ses") || t.includes("audio")) return icon("volume-2", 13);
  if (t.includes("net") || t.includes("ağ") || t.includes("broadband") || t.includes("internet")) return icon("globe", 13);
  return icon("shield", 13);
}

function getHardwareLabel(title: string): string {
  const t = title.toLowerCase().trim();
  if (t.includes("os") || t.includes("işletim")) return "İşletim Sistemi";
  if (t.includes("processor") || t.includes("işlemci") || t.includes("cpu")) return "İşlemci (CPU)";
  if (t.includes("memory") || t.includes("bellek") || t.includes("ram")) return "Bellek (RAM)";
  if (t.includes("storage") || t.includes("depolama") || t.includes("space")) return "Depolama Alanı";
  if (t.includes("graphics") || t.includes("ekran") || t.includes("gpu")) return "Ekran Kartı (GPU)";
  if (t.includes("direct")) return "DirectX Sürümü";
  if (t.includes("sound") || t.includes("ses") || t.includes("audio")) return "Ses Kartı";
  if (t.includes("net") || t.includes("ağ") || t.includes("internet")) return "İnternet / Ağ Bağlantısı";
  if (t.includes("other") || t.includes("ek")) return "Ek Gereksinimler";
  return title;
}

function isWinSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("win") || s.includes("pc");
}

function isMacSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("mac") || s.includes("osx") || s.includes("apple");
}

function renderDrawerSystemRequirements(s: EpicSummary): string {
  if (loadingReqFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Epic Games Store sistem gereksinimleri alınıyor…</div>
      </div>`;
  }

  const data = loadedRequirements.get(s.appName);
  if (!data) {
    if (loadingReqFor !== s.appName) {
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
      activeSystemPlatform === "Windows" ? isWinSys(sys.systemType) : isMacSys(sys.systemType)
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
  if (loadingReqFor === appName) return;
  loadingReqFor = appName;
  try {
    const data = await epicGetSystemRequirements(title, appName, forceRefresh);
    loadedRequirements.set(appName, data);
  } catch (e) {
    console.warn("Sistem gereksinimleri alınamadı:", e);
    loadedRequirements.set(appName, {
      supported: false,
      systems: [],
      languages: [],
      appName,
    });
  } finally {
    loadingReqFor = null;
    if (currentModalAppName === appName && activeDrawerTab === "specs") {
      openEpicModal(appName, false);
    }
  }
}


async function epicOpenFolder(appName: string): Promise<void> {
  const s = epicSummaries.find((x) => x.appName === appName);
  if (!s?.installPath) {
    toast("Kurulum klasörü bilinmiyor", "err");
    return;
  }
  try {
    if (isTauri) {
      const msg = await invoke<string>("open_folder", { path: s.installPath });
      toast(msg, "ok");
    } else toast(`(demo) ${s.installPath}`, "");
  } catch (e) {
    toast(String(e), "err");
  }
}

function renderShelfHeroCard(s: EpicSummary): string {
  const wideImg = epicWideArt(s) || s.cover;
  const g = rawOf(s.appName);
  const devRaw = g?.metadata?.developer;
  const dev = typeof devRaw === "string" ? devRaw : "Epic Games";
  const p = epicDlProgress(s.appName);
  const partner = getThirdPartyLauncher(g);
  const isRunning = runningGames.has(s.appName);
  const pt = playtimeMap.get(s.appName);

  const primaryBtn =
    p !== null
      ? `<button class="btn primary small" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : isRunning
        ? `<button class="btn primary small running" data-id="${s.appName}"><span class="running-dot"></span> Oynanıyor…</button>`
        : s.installed
          ? `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("play", 13)} Oyna</button>`
          : partner
            ? `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} Başlat</button>`
            : `<button class="btn primary small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} Yükle</button>`;

  return `
    <div class="shelf-hero-card" data-act="epic-detail" data-id="${s.appName}">
      ${wideImg ? `<img class="shelf-hero-bg" src="${esc(wideImg)}" alt="" />` : ""}
      <div class="shelf-hero-gradient"></div>
      <div class="shelf-hero-body">
        <div class="shelf-hero-tag">${icon("play", 10)} Son Oynanan</div>
        <div class="shelf-hero-title">${esc(s.title)}</div>
        <div class="shelf-hero-meta">
          <span>${esc(dev)}</span>
          ${pt && pt.total_seconds > 0 ? `<span>•</span><span style="color:#38bdf8">${icon("clock", 10)} ${fmtPlaytime(pt.total_seconds)}</span>` : ""}
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          ${primaryBtn}
          <button class="btn ghost small" data-act="epic-detail" data-id="${s.appName}">${icon("dots", 13)} Detaylar</button>
        </div>
      </div>
    </div>
  `;
}

function renderShelfSection(
  iconOrEmoji: any,
  title: string,
  items: EpicSummary[],
  featuredFirst = false,
  isEmoji = false,
): string {
  if (items.length === 0) return "";
  const firstItem = featuredFirst ? items[0] : null;
  const restItems = featuredFirst ? items.slice(1) : items;

  return `
    <div class="shelf-section">
      <div class="shelf-header">
        <div class="shelf-title-group">
          <span class="shelf-icon">${isEmoji ? `<span class="shelf-emoji">${esc(iconOrEmoji)}</span>` : icon(iconOrEmoji, 15)}</span>
          <h3 class="shelf-title">${esc(title)}</h3>
          <span class="shelf-badge">${items.length}</span>
        </div>
        <div class="shelf-nav">
          <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="left" title="Sola Kaydır">${icon("chevron-left", 14)}</button>
          <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="right" title="Sağa Kaydır">${icon("chevron-right", 14)}</button>
        </div>
      </div>
      <div class="shelf-featured-wrap">
        ${firstItem ? renderShelfHeroCard(firstItem) : ""}
        <div class="shelf-row-track">
          ${restItems.map((s, idx) => epicCardPortrait(s, idx)).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderEpicShelves(): string {
  const visible = epicVisibleSummaries();
  // If search query is active or a single collection/filter is chosen, show focused shelf
  if (query.trim() || epicFilter !== "all" || (activeCollectionId && activeCollectionId !== "all")) {
    const activeCol = activeCollectionId ? epicCollections.find((c) => c.id === activeCollectionId) : null;
    const title = query.trim()
      ? `Arama Sonuçları: "${query.trim()}"`
      : epicFilter === "installed"
        ? "Yüklü Oyunlar"
        : epicFilter === "fav"
          ? "Favoriler"
          : epicFilter === "platinum"
            ? "Platin Kupalar"
            : epicFilter === "updates"
              ? "Güncellemeler"
              : activeCol
                ? activeCol.name
                : "Oyunlar";

    return `
      <div class="shelf-section">
        <div class="shelf-header">
          <div class="shelf-title-group">
            <span class="shelf-icon">${activeCol?.emoji ? `<span class="shelf-emoji">${esc(activeCol.emoji)}</span>` : icon("rows", 15)}</span>
            <h3 class="shelf-title">${esc(title)}</h3>
            <span class="shelf-badge">${visible.length}</span>
          </div>
        </div>
        <div class="pgrid size-${epicCardSize}">
          ${visible.map((s, idx) => epicCardPortrait(s, idx)).join("") || `<div class="empty">Oyun bulunamadı.</div>`}
        </div>
      </div>
    `;
  }

  // Steam-Style Standard Shelves
  const sections: string[] = [];

  // 1. Son Oynananlar (Recent Shelf)
  const recentGames = epicRecent
    .map((id) => epicSummaries.find((s) => s.appName === id && s.installed))
    .filter((s): s is EpicSummary => !!s);

  if (recentGames.length > 0) {
    sections.push(renderShelfSection("clock", "Son Oynananlar", recentGames, true));
  }

  // 2. Yüklü Oyunlar (Installed Shelf)
  const installedGames = epicSummaries.filter((s) => s.installed);
  if (installedGames.length > 0) {
    sections.push(renderShelfSection("gamepad-2", "Yüklü Oyunlar", installedGames));
  }

  // 3. Favoriler (Favorites Shelf)
  const favGames = epicSummaries.filter((s) => epicFav.has(s.appName));
  if (favGames.length > 0) {
    sections.push(renderShelfSection("heart", "Favoriler", favGames));
  }

  // 4. Platin Kupalar (Platinum Shelf)
  const platGames = epicSummaries.filter((s) => isAppPlatinum(s.appName));
  if (platGames.length > 0) {
    sections.push(renderShelfSection("trophy", "Platin Kupalı Oyunlar", platGames));
  }

  // 5. Kullanıcı Koleksiyonları
  for (const col of epicCollections) {
    const colGames = epicSummaries.filter((s) =>
      col.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
    );
    if (colGames.length > 0) {
      sections.push(renderShelfSection(col.emoji || "folder", col.name, colGames, false, Boolean(col.emoji)));
    }
  }

  // Fallback if no shelves have content
  if (sections.length === 0) {
    sections.push(renderShelfSection("layout-grid", "Tüm Oyunlar", epicSummaries.slice(0, 30)));
  }

  return `<div class="shelves-container">${sections.join("")}</div>`;
}

function renderEpicItems(): string {
  if (epicViewMode === "shelves") {
    return renderEpicShelves();
  }
  const visible = epicVisibleSummaries();
  return (
    visible.map(epicViewMode === "grid" ? epicCardPortrait : epicRowHtml).join("") ||
    `<div class="empty">Oyun bulunamadı.</div>`
  );
}

function renderSkeletonLibrary(): string {
  const skelCards = Array.from({ length: 12 })
    .map(
      () => `
      <div class="pcard skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-badge"></div>
        <div class="skeleton-overlay">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
        </div>
      </div>`
    )
    .join("");

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">Kütüphane</h1>
        <div class="skeleton-pill" style="width:120px;height:24px;border-radius:20px;"></div>
      </div>
      <div class="lib-top-actions">
        <div class="skeleton-pill" style="width:75px;height:36px;border-radius:10px;"></div>
        <div class="skeleton-circle" style="width:36px;height:36px;border-radius:10px;"></div>
      </div>
    </div>
    ${!isHeroCollapsed ? `
    <div class="skeleton-hero" style="height:240px;margin-bottom:20px;">
      <div class="skeleton-hero-badge"></div>
      <div class="skeleton-hero-title"></div>
      <div class="skeleton-hero-meta"></div>
      <div class="skeleton-hero-actions">
        <div class="skeleton-pill" style="width:110px;height:32px;border-radius:8px;"></div>
        <div class="skeleton-pill" style="width:85px;height:32px;border-radius:8px;"></div>
      </div>
    </div>` : ""}
    <div class="lib-unified-toolbar" style="margin-bottom:18px;">
      <div class="unified-toolbar-left">
        <div class="skeleton-pill" style="width:75px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:85px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:95px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:80px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:110px;height:32px;border-radius:9px;"></div>
      </div>
      <div class="unified-toolbar-right">
        <div class="skeleton-pill" style="width:180px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:105px;height:32px;border-radius:9px;"></div>
      </div>
    </div>
    <div class="pgrid size-${epicCardSize}">${skelCards}</div>`;
}

function renderEpic(): string {
  if (!isTauri) {
    return `<h2>${icon("zap", 18)} Epic</h2><p class="subtitle">Epic entegrasyonu</p><div class="empty">Bu bölüm yalnızca masaüstü uygulamasında çalışır.</div>`;
  }
  if (epicPhase === "checking" || (epicPhase === "library" && epicSummaries.length === 0)) {
    return renderSkeletonLibrary();
  }
  if (epicPhase === "setup") {
    const pct = setupProgress ?? 0;
    return `
      <h2>Kütüphane</h2><p class="subtitle">Önce legendary gerekli</p>
      <div class="settings-box">
        <p>Epic oyunların için açık kaynak <strong>legendary</strong> aracı kullanılır. Tek seferlik indirilir (~45 MB).</p>
        ${epicBusy === "download" ? `<div class="bar" style="margin:12px 0"><div style="width:${pct}%"></div></div><p class="muted">${esc(setupMessage || "indiriliyor…")}</p>` : ""}
        <p><button class="btn primary" data-act="epic-download" ${epicBusy ? "disabled" : ""}>${epicBusy ? "İndiriliyor…" : "legendary'yi indir"}</button></p>
        <p class="muted">Kaynak: github.com/legendary-gl/legendary (GPL-3.0)</p>
      </div>`;
  }
  if (epicPhase === "login") {
    return `
      <h2>Kütüphane</h2><p class="subtitle">Hesabınla giriş yap</p>
      <div class="settings-box">
        <ol class="steps">
          <li><button class="btn ghost small" data-act="epic-open-login">Epic giriş sayfasını aç</button> ve giriş yap.</li>
          <li>Açılan JSON yanıttaki <code>authorizationCode</code> değerini (veya tüm JSON'u) yapıştır:</li>
        </ol>
        <p><input id="epic-code" class="text-input" placeholder='{"authorizationCode": "..."}' autocomplete="off" spellcheck="false" /></p>
        <p style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" data-act="epic-do-login" ${epicBusy ? "disabled" : ""}>${epicBusy === "login" ? "Giriş yapılıyor…" : "Giriş yap"}</button>
          <button class="btn ghost" data-act="epic-import" ${epicBusy ? "disabled" : ""}>${epicBusy === "import" ? "Aktarılıyor…" : "Epic Launcher'dan aktar"}</button>
        </p>
      </div>`;
  }
  if (epicPhase === "error") {
    return `
      <h2>Kütüphane</h2><p class="subtitle">Bir sorun oluştu</p>
      <div class="settings-box">
        <p><code>${esc(epicError)}</code></p>
        <p style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn ghost" data-act="epic-retry">Tekrar dene</button>
          <button class="btn danger" data-act="epic-logout">Epic'ten çıkış yap</button>
        </p>
        <p class="muted">Oturum sorunlarında çıkış yapıp kod ile tekrar giriş yapmak çözer.</p>
      </div>`;
  }

  const favTotalCount = epicSummaries.filter((s) => epicFav.has(s.appName)).length;
  const allInstalledCount = epicSummaries.filter((s) => s.installed).length;
  const totalInstalledSize = epicSummaries.reduce((acc, x) => acc + (x.installSize || 0), 0);

  const selectedCol =
    activeCollectionId && activeCollectionId !== "all" && activeCollectionId !== "fav"
      ? epicCollections.find((c) => c.id === activeCollectionId)
      : null;

  const visibleColSummaries =
    selectedCol
      ? epicSummaries.filter((s) =>
          selectedCol.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
        )
      : activeCollectionId === "fav"
        ? epicSummaries.filter((s) => epicFav.has(s.appName))
        : epicSummaries;

  const totalColCount = visibleColSummaries.length;
  const installedCount = visibleColSummaries.filter((s) => s.installed).length;
  const updateCount = visibleColSummaries.filter((s) => s.updateAvailable || availableUpdates.has(s.appName)).length;
  const allUpdatesCount = epicSummaries.filter((s) => s.updateAvailable || availableUpdates.has(s.appName)).length;
  const platCount = visibleColSummaries.filter((s) => isAppPlatinum(s.appName)).length;

  const isUpdateNewlyAdded = prevRenderedUpdatesCount === 0 && allUpdatesCount > 0;
  const isColNewlyChanged = prevRenderedColId !== undefined && prevRenderedColId !== activeCollectionId;
  prevRenderedUpdatesCount = allUpdatesCount;
  prevRenderedColId = activeCollectionId;

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">Kütüphane</h1>
        <div class="lib-heading-stats">
          <span class="stat-dot"></span>
          <span>${epicSummaries.length} Oyun</span>
          <span class="stat-sep">•</span>
          <span style="color:#10b981;font-weight:700">${allInstalledCount} Yüklü</span>
          <span class="stat-sep">•</span>
          <span>${fmtBytes(totalInstalledSize)}</span>
        </div>
      </div>
      <div class="lib-top-actions">
        <button class="lib-toggle-hero-btn ${isHeroCollapsed ? "active" : ""}" data-act="toggle-hero-spotlight" title="${isHeroCollapsed ? "Öne çıkan vitrini göster" : "Öne çıkan vitrini gizle"}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <span>${isHeroCollapsed ? "Vitrini Aç" : "Vitrin"}</span>
        </button>
        <button class="lib-refresh-btn ${epicSyncing ? "spinning" : ""}" data-act="epic-refresh" title="Kütüphaneyi Yenile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </button>
      </div>
    </div>

    ${renderHeroSpotlight()}

    <div class="lib-unified-toolbar">
      <div class="unified-toolbar-left">
        <button class="unified-pill ${activeCollectionId === null && epicFilter === "all" ? "active" : ""}" data-act="quick-tab" data-tab="all">
          <span>Tümü</span>
          <span class="pill-cnt">${epicSummaries.length}</span>
        </button>
        <button class="unified-pill ${epicFilter === "installed" ? "active" : ""}" data-act="quick-tab" data-tab="installed">
          <span class="pill-dot installed"></span>
          <span>Yüklü</span>
          <span class="pill-cnt">${allInstalledCount}</span>
        </button>
        <button class="unified-pill ${activeCollectionId === "fav" || epicFilter === "fav" ? "active" : ""}" data-act="quick-tab" data-tab="fav">
          <span class="pill-icon">${icon("heart", 13)}</span>
          <span>Favoriler</span>
          <span class="pill-cnt">${favTotalCount}</span>
        </button>
        <button class="unified-pill ${epicFilter === "platinum" ? "active" : ""}" data-act="quick-tab" data-tab="platinum">
          <span class="pill-icon">${icon("trophy", 13)}</span>
          <span>Platin</span>
          <span class="pill-cnt">${platCount}</span>
        </button>
        ${allUpdatesCount > 0 ? `
        <button class="unified-pill ${isUpdateNewlyAdded ? "pill-dynamic" : ""} ${epicFilter === "updates" ? "active" : ""}" data-act="quick-tab" data-tab="updates">
          <span class="pill-icon">${icon("zap", 13)}</span>
          <span>Güncelleme</span>
          <span class="pill-cnt">${allUpdatesCount}</span>
        </button>` : ""}

        <div class="col-dropdown-container">
          ${selectedCol ? `
          <button class="unified-pill col-btn active ${isColNewlyChanged ? "pill-dynamic" : ""}" data-act="toggle-col-dropdown" title="${esc(selectedCol.name)} koleksiyonu seçili">
            ${selectedCol.emoji ? `<span class="col-pill-emoji">${esc(selectedCol.emoji)}</span>` : icon("folder", 13)}
            <span class="col-btn-name">${esc(selectedCol.name)}</span>
            <span class="pill-cnt">${totalColCount}</span>
            <span class="col-clear-btn" data-act="clear-collection" title="Koleksiyon filtresini kaldır">${icon("x", 11)}</span>
          </button>` : `
          <button class="unified-pill col-btn ${isColNewlyChanged ? "pill-dynamic" : ""}" data-act="toggle-col-dropdown" title="Koleksiyonlar">
            ${icon("folder", 13)}
            <span>Koleksiyonlar</span>
            ${epicCollections.length > 0 ? `<span class="pill-cnt">${epicCollections.length}</span>` : ""}
            <span class="dropdown-chevron">▾</span>
          </button>`}

          <div id="col-dropdown-menu" class="col-dropdown-menu ${isColDropdownOpen ? "show" : ""}">
            <div class="col-menu-header">Koleksiyonlar</div>
            <div class="col-menu-list">
              ${epicCollections.length === 0 ? `<div style="padding:10px;font-size:12px;color:var(--muted);text-align:center">Henüz koleksiyon oluşturulmadı</div>` : ""}
              ${epicCollections.map((col) => {
                const count = epicSummaries.filter((s) => col.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase())).length;
                const isAct = activeCollectionId === col.id;
                return `
                <div class="col-menu-item-row ${isAct ? "selected" : ""}">
                  <button class="col-menu-item-btn" data-act="select-collection" data-col-id="${esc(col.id)}">
                    ${col.emoji ? `<span class="col-menu-emoji">${esc(col.emoji)}</span>` : `<span class="col-menu-dot"></span>`}
                    <span class="col-menu-name">${esc(col.name)}</span>
                    <span class="col-menu-count">${count}</span>
                  </button>
                  <button class="col-menu-edit-btn" data-act="edit-collection" data-col-id="${esc(col.id)}" title="${esc(col.name)} koleksiyonunu düzenle">
                    ${icon("edit", 12)}
                  </button>
                </div>`;
              }).join("")}
            </div>
            <div class="col-menu-footer">
              <button class="col-menu-action-btn" data-act="open-new-collection-modal">
                ${icon("folder", 13)}
                <span>+ Yeni Koleksiyon</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="unified-toolbar-right">
        <label class="unified-search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="search" type="search" placeholder="Kütüphanede ara..." value="${esc(query)}" autocomplete="off" spellcheck="false" />
          <span class="search-shortcut">Ctrl+F</span>
        </label>
        ${(() => {
          const currentSortOpt = sortOptions.find((o) => o.id === epicSort) || sortOptions[0];
          return `
        <div class="sort-dropdown-container">
          <button class="unified-pill sort-btn" data-act="toggle-sort-dropdown" title="Sıralama: ${esc(currentSortOpt.label)}">
            ${icon(currentSortOpt.icon, 13)}
            <span class="sort-btn-label">${esc(currentSortOpt.label)}</span>
            <span class="dropdown-chevron">▾</span>
          </button>
          <div id="sort-dropdown-menu" class="sort-dropdown-menu ${isSortDropdownOpen ? "show" : ""}">
            <div class="sort-menu-header">Sırala</div>
            <div class="sort-menu-list">
              ${sortOptions.map((opt) => {
                const isSelected = epicSort === opt.id;
                return `
                  <button class="sort-menu-item-btn ${isSelected ? "selected" : ""}" data-act="select-sort" data-sort="${opt.id}">
                    <span class="sort-menu-item-icon">${icon(opt.icon, 13)}</span>
                    <span class="sort-menu-item-name" style="flex:1">${esc(opt.label)}</span>
                    ${isSelected ? icon("check", 12) : ""}
                  </button>
                `;
              }).join("")}
            </div>
          </div>
        </div>`;
        })()}
        <div class="card-size-toggle" title="Kart boyutu">
          <button class="${epicCardSize === "compact" ? "active" : ""}" data-act="epic-size" data-val="compact" title="Küçük">S</button>
          <button class="${epicCardSize === "normal" ? "active" : ""}" data-act="epic-size" data-val="normal" title="Normal">M</button>
          <button class="${epicCardSize === "large" ? "active" : ""}" data-act="epic-size" data-val="large" title="Büyük">L</button>
        </div>
        <div class="view-mode-toggle">
          <button class="${epicViewMode === "grid" ? "active" : ""}" data-act="epic-view-grid" title="Izgara Görünümü">${icon("layout-grid", 13)}</button>
          <button class="${epicViewMode === "shelves" ? "active" : ""}" data-act="epic-view-shelves" title="Raflar Görünümü">${icon("rows", 13)}</button>
          <button class="${epicViewMode === "list" ? "active" : ""}" data-act="epic-view-list" title="Liste Görünümü">${icon("list", 13)}</button>
        </div>
      </div>
    </div>
    ${epicSyncNote ? `<p class="subtitle">${esc(epicSyncNote)}</p>` : ""}
    ${epicFilter === "platinum" ? `
    <div class="plat-category-banner">
      <div class="plat-banner-glow"></div>
      <div class="plat-banner-icon">${icon("trophy", 28)}</div>
      <div class="plat-banner-info">
        <div class="plat-banner-title">Platin Kupa Koleksiyonu</div>
        <div class="plat-banner-desc">Tüm başarımlarını %100 tamamlayarak vitrine eklediğin oyunlar. Harika iş!</div>
      </div>
      <div class="plat-banner-stat">
        <div class="val">${platCount}</div>
        <div class="lbl">Tamamlandı</div>
      </div>
    </div>` : ""}
    <div id="lib-results" class="${epicViewMode === "grid" ? `pgrid size-${epicCardSize}` : epicViewMode === "shelves" ? "shelves-container" : ""}">${renderEpicItems()}</div>`;
}

function updateLibraryFilterInPlace(): boolean {
  if (view !== "library") return false;
  const toolbar = document.querySelector(".lib-unified-toolbar");
  const resultsEl = document.getElementById("lib-results");
  if (!toolbar || !resultsEl) return false;

  toolbar.querySelectorAll<HTMLElement>(".unified-pill[data-act='quick-tab']").forEach((pill) => {
    const tab = pill.dataset.tab;
    const isAct =
      tab === "all"
        ? activeCollectionId === null && epicFilter === "all"
        : tab === "fav"
          ? activeCollectionId === "fav" || epicFilter === "fav"
          : tab === "installed"
            ? epicFilter === "installed"
            : tab === "platinum"
              ? epicFilter === "platinum"
              : tab === "updates"
                ? epicFilter === "updates"
                : false;
    pill.classList.toggle("active", isAct);
  });

  const platBanner = document.querySelector(".plat-category-banner") as HTMLElement | null;
  if (epicFilter === "platinum") {
    if (!platBanner) {
      const platCount = epicSummaries.filter((s) => isAppPlatinum(s.appName)).length;
      const bannerHtml = `
        <div class="plat-category-banner">
          <div class="plat-banner-glow"></div>
          <div class="plat-banner-icon">${icon("trophy", 28)}</div>
          <div class="plat-banner-info">
            <div class="plat-banner-title">Platin Kupa Koleksiyonu</div>
            <div class="plat-banner-desc">Tüm başarımlarını %100 tamamlayarak vitrine eklediğin oyunlar. Harika iş!</div>
          </div>
          <div class="plat-banner-stat">
            <div class="val">${platCount}</div>
            <div class="lbl">Tamamlandı</div>
          </div>
        </div>`;
      resultsEl.insertAdjacentHTML("beforebegin", bannerHtml);
    }
  } else if (platBanner) {
    platBanner.remove();
  }

  resultsEl.className = epicViewMode === "grid" ? `pgrid size-${epicCardSize}` : epicViewMode === "shelves" ? "shelves-container" : "";
  resultsEl.style.animation = "none";
  void resultsEl.offsetHeight;
  resultsEl.style.animation = "";
  resultsEl.innerHTML = renderEpicItems();

  return true;
}

function closeModal(): void {
  modalRoot.innerHTML = "";
  currentModalAppName = null;
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
  activeCustomCoverAppName = appName;
  activeCoverTarget = initialTarget;
  const s = epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;

  sgdbSearchQuery = cleanSteamGridSearchTerm(title);
  sgdbAssetType = activeCoverTarget === "hero" ? "heroes" : "grids";
  sgdbActiveStyle = "";
  sgdbSelectedCoverUrl = "";
  customCoverActiveTab = steamGridApiKey ? "steamgrid" : "url";
  sgdbErrorMsg = "";
  sgdbCoversList = [];
  sgdbGamesList = [];
  sgdbSelectedGameId = null;
  showModalSgdbInfo = false;

  renderCustomCoverModalFrame(appName);
  renderCustomCoverModalContent(appName);

  if (steamGridApiKey && sgdbSearchQuery) {
    void searchAndLoadSteamGrid(appName, sgdbSearchQuery);
  }
}

function renderCustomCoverModalFrame(appName: string): void {
  const coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) return;
  const s = epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;
  const g = rawOf(appName);
  const devRaw = g ? g.metadata?.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";

  const hasCustomCover = Boolean(customCovers[appName]);
  const hasCustomHero = Boolean(customHeroes[appName]);
  const isCustomForTarget = activeCoverTarget === "hero" ? hasCustomHero : hasCustomCover;

  const currentCoverArt = customCovers[appName] || s?.cover || "";
  const currentHeroArt = customHeroes[appName] || (s ? epicWideArt(s) : null) || s?.cover || "";
  const activeCurrentImg = sgdbSelectedCoverUrl || (activeCoverTarget === "hero" ? currentHeroArt : currentCoverArt);
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
            <button class="target-segment-pill ${activeCoverTarget === "cover" ? "active" : ""}" data-act="set-cover-target" data-target="cover" data-id="${appName}">
              ${icon("image", 14)}
              <span>Dikey Kapak (2:3 Kütüphane)</span>
              ${hasCustomCover ? `<span class="target-indicator-dot" title="Özel dikey kapak aktif"></span>` : ""}
            </button>
            <button class="target-segment-pill ${activeCoverTarget === "hero" ? "active" : ""}" data-act="set-cover-target" data-target="hero" data-id="${appName}">
              ${icon("rows", 14)}
              <span>Yatay Afiş (Hero / Vitrin)</span>
              ${hasCustomHero ? `<span class="target-indicator-dot" title="Özel yatay afiş aktif"></span>` : ""}
            </button>
          </div>

          <!-- Canlı Önizleme ve Hedef Bilgisi -->
          <div class="cover-preview-section">
            <div class="cover-preview-card ${activeCoverTarget === "hero" ? "wide" : "portrait"}">
              ${activeCurrentImg ? `<img id="cover-preview-img" src="${esc(activeCurrentImg)}" alt="Önizleme" />` : `<div id="cover-preview-img" class="cover-preview-empty">${icon("image", 36)}</div>`}
              <div class="cover-preview-badge">${sgdbSelectedCoverUrl ? "Seçilen Önizleme" : isCustomForTarget ? "Özel Görsel" : "Orijinal"}</div>
            </div>
            <div class="cover-preview-meta">
              <div class="cover-meta-header">
                <span class="cover-meta-badge ${activeCoverTarget}">
                  ${activeCoverTarget === "cover" ? `${icon("image", 12)} 2:3 Kütüphane Kartı` : `${icon("rows", 12)} 16:7 Vitrin & Detay Afişi`}
                </span>
                ${isCustomForTarget ? `<span class="cover-status-tag custom">${icon("sparkles", 11)} Özel Görsel Kullanılıyor</span>` : `<span class="cover-status-tag">${icon("check", 11)} Orijinal Epic Görseli</span>`}
              </div>
              <div class="cover-meta-desc">
                ${activeCoverTarget === "cover"
                  ? "Kütüphane ızgarasında ve listelerde görünen dikey afiş. SteamGridDB'den beğendiğiniz bir kapak seçebilir veya web bağlantısı yapıştırabilirsiniz."
                  : "Ana sayfadaki öne çıkan vitrinde (Spotlight), detay çekmecesinde ve raflarda arka plan olarak kullanılan sinematik yatay afiş."}
              </div>
              <div class="cover-meta-actions">
                ${isCustomForTarget ? `
                  <button class="btn ghost small danger" data-act="reset-active-target" data-id="${appName}">
                    ${icon("refresh", 12)} ${activeCoverTarget === "cover" ? "Dikey Kapağı Sıfırla" : "Yatay Afişi Sıfırla"}
                  </button>
                ` : ""}
              </div>
            </div>
          </div>

          <!-- Kaynak Sekmeleri -->
          <div class="cover-modal-tabs">
            <button class="cover-tab-btn ${customCoverActiveTab === "steamgrid" ? "active" : ""}" data-act="switch-cover-tab" data-tab="steamgrid" data-id="${appName}">
              ${icon("globe", 13)} <span>SteamGridDB Topluluğu</span>
            </button>
            <button class="cover-tab-btn ${customCoverActiveTab === "url" ? "active" : ""}" data-act="switch-cover-tab" data-tab="url" data-id="${appName}">
              ${icon("external", 13)} <span>Doğrudan Web URL</span>
            </button>
            <button class="cover-tab-btn ${(customCoverActiveTab as string) === "file" ? "active" : ""}" data-act="switch-cover-tab" data-tab="file" data-id="${appName}">
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
            ${icon("check", 14)} ${activeCoverTarget === "cover" ? "Dikey Kapağı Kaydet" : "Yatay Afişi Kaydet"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCustomCoverModalContent(appName: string): void {
  const container = document.getElementById("cover-tab-content-area");
  if (!container) return;

  if (customCoverActiveTab === "url") {
    const currentVal = sgdbSelectedCoverUrl || (activeCoverTarget === "hero" ? customHeroes[appName] : customCovers[appName]) || "";
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

  if (customCoverActiveTab === "file") {
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
  if (!steamGridApiKey) {
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
            <input id="modal-sgdb-key-input" type="${showModalSgdbKey ? "text" : "password"}" class="text-input" placeholder="API Anahtarınızı (Token) buraya yapıştırın..." spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="toggle-modal-sgdb-key-visibility" title="Göster/Gizle">${icon(showModalSgdbKey ? "eye-off" : "eye", 13)}</button>
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
          <input id="sgdb-search-input" class="text-input" placeholder="Oyun adı ara..." value="${esc(sgdbSearchQuery)}" spellcheck="false" autocomplete="off" />
          <button class="btn primary small" data-act="sgdb-search" data-id="${appName}" ${sgdbIsSearching ? "disabled" : ""}>
            ${sgdbIsSearching ? icon("refresh", 12) : icon("search", 12)}
            <span>${sgdbIsSearching ? "Aranıyor…" : "Ara"}</span>
          </button>
          <button class="btn ghost small ${showModalSgdbInfo ? "active" : ""}" data-act="toggle-sgdb-modal-info" title="SteamGridDB Bilgi">
            ${icon("info", 13)}
          </button>
        </div>

        ${showModalSgdbInfo ? `
        <div class="sgdb-info-card compact">
          <div class="sgdb-info-header">
            <div class="sgdb-info-title">${icon("info", 13)} <span>SteamGridDB Topluluk Kütüphanesi</span></div>
            <button data-act="toggle-sgdb-modal-info" title="Kapat">${icon("x", 12)}</button>
          </div>
          <div class="sgdb-info-content">
            <p style="margin:0">SteamGridDB; video oyunları için resmi ve topluluk yapımı dikey kapak (2:3) ve vitrin afişi (Hero) barındıran açık platformdur. Seçtiğiniz görseller kütüphaneniz için anında uygulanır.</p>
            <div style="display:flex;align-items:center;gap:12px;margin-top:2px;font-size:11px;color:#94a3b8">
              <span>Kayıtlı Anahtar: <code>${esc(steamGridApiKey.slice(0, 5))}••••••</code></span>
              <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:10.5px;padding:2px 8px">
                ${icon("external", 11)} Anahtarı Yönet
              </button>
            </div>
          </div>
        </div>
        ` : ""}

        ${sgdbGamesList.length > 1 ? `
        <div class="sgdb-matching-games-bar">
          <span class="sgdb-matching-label">${icon("gamepad-2", 12)} Oyunlar:</span>
          <div class="sgdb-matching-chips-track">
            ${sgdbGamesList.map(g => `
              <button class="sgdb-game-chip ${sgdbSelectedGameId === g.id ? "active" : ""}" data-act="sgdb-select-game" data-game-id="${g.id}" data-id="${appName}" title="${esc(g.name)} (ID: ${g.id})">
                ${esc(g.name)}
              </button>
            `).join("")}
          </div>
        </div>` : ""}

        <div class="sgdb-filter-bar">
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${sgdbAssetType === "grids" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="grids" data-id="${appName}">
              ${icon("image", 11)} Dikey (2:3)
            </button>
            <button class="sgdb-chip ${sgdbAssetType === "heroes" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="heroes" data-id="${appName}">
              ${icon("rows", 11)} Yatay Afiş (Hero)
            </button>
          </div>
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${sgdbActiveStyle === "" ? "active" : ""}" data-act="sgdb-set-style" data-style="" data-id="${appName}">Tümü</button>
            <button class="sgdb-chip ${sgdbActiveStyle === "official" ? "active" : ""}" data-act="sgdb-set-style" data-style="official" data-id="${appName}">Resmi</button>
            <button class="sgdb-chip ${sgdbActiveStyle === "no_logo" ? "active" : ""}" data-act="sgdb-set-style" data-style="no_logo" data-id="${appName}">Logosuz</button>
            <button class="sgdb-chip ${sgdbActiveStyle === "alternate" ? "active" : ""}" data-act="sgdb-set-style" data-style="alternate" data-id="${appName}">Alternatif</button>
          </div>
        </div>

        <div class="sgdb-gallery">
          ${sgdbIsSearching ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:8px">
              ${icon("refresh", 16)} SteamGridDB üzerinden taranıyor…
            </div>
          ` : sgdbErrorMsg ? `
            <div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
              ${esc(sgdbErrorMsg)}
            </div>
          ` : sgdbCoversList.length === 0 ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">
              Uygun görsel bulunamadı. Farklı bir arama terimi deneyin.
            </div>
          ` : `
            <div class="${sgdbAssetType === "heroes" ? "sgdb-grid-horizontal" : "sgdb-grid-vertical"}">
              ${sgdbCoversList.map(item => {
                const isSel = sgdbSelectedCoverUrl === item.url;
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
  if (!steamGridApiKey) {
    renderCustomCoverModalContent(appName);
    return;
  }
  sgdbIsSearching = true;
  sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);

  const term = query !== undefined ? query.trim() : sgdbSearchQuery.trim();
  if (!term) {
    sgdbIsSearching = false;
    sgdbGamesList = [];
    sgdbCoversList = [];
    renderCustomCoverModalContent(appName);
    return;
  }

  try {
    const games = await epicSearchSteamGrid(term);
    sgdbGamesList = games;
    if (games.length > 0) {
      sgdbSelectedGameId = games[0].id;
      await loadSteamGridCovers(appName, games[0].id);
    } else {
      sgdbSelectedGameId = null;
      sgdbCoversList = [];
      sgdbIsSearching = false;
      renderCustomCoverModalContent(appName);
    }
  } catch (err) {
    sgdbErrorMsg = String(err);
    sgdbCoversList = [];
    sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

async function loadSteamGridCovers(appName: string, gameId: number): Promise<void> {
  sgdbIsSearching = true;
  sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);
  try {
    const covers = await epicGetSteamGridCovers(gameId, sgdbAssetType, sgdbActiveStyle || undefined);
    sgdbCoversList = covers;
  } catch (err) {
    sgdbErrorMsg = String(err);
    sgdbCoversList = [];
  } finally {
    sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

function closeEditPlaytimeModal(): void {
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

function openEditPlaytimeModal(appName: string): void {
  if (!playtimeRoot) return;
  const s = epicSummaries.find((x) => x.appName === appName);
  const dl = downloads.get(appName);
  const title = s?.title || dl?.title || appName;

  const pt = playtimeMap.get(appName);
  const sec = pt?.total_seconds || 0;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  let lastPlayed = pt?.last_played || "";
  if (!lastPlayed && (hours > 0 || minutes > 0)) {
    lastPlayed = "Daha önce oynandı (Epic Games)";
  }

  const standardOptions = [
    "",
    "Daha önce oynandı (Epic Games)",
    "Bugün",
    "Dün",
    "Bu hafta",
    "Bu ay",
    "Geçen ay",
    "6 ay önce",
    "1 yıl önce veya daha eski",
  ];
  const hasCustomLastPlayed = Boolean(lastPlayed && !standardOptions.includes(lastPlayed));

  playtimeRoot.innerHTML = `
    <div class="playtime-overlay" data-act="playtime-overlay-close">
      <div class="playtime-dialog">
        <div class="playtime-header">
          <div class="playtime-header-title">
            <div class="playtime-header-icon">${icon("clock", 18)}</div>
            <div>
              <h2>Oynama Süresini Düzenle</h2>
              <div class="playtime-header-sub">${esc(title)}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-edit-playtime" title="Kapat">${icon("x", 16)}</button>
        </div>

        <div class="playtime-body">
          <div class="playtime-modal-notice">
            <div class="playtime-modal-notice-icon">${icon("info", 16)}</div>
            <div class="playtime-modal-notice-text">
              <strong>Epic Games Verileri Neden Otomatik Alınamıyor?</strong><br />
              Epic Games Store, oynama sürelerini yalnızca kendi sunucularındaki kapalı telemetride depolar ve 3. parti istemcilerin (Heroic, GOG vb.) erişebileceği bir REST/GraphQL veya OAuth API sağlamaz.
              Önceki Epic sürenizi buradan bir defaya mahsus girdiğinizde, gelecekteki oyun oturumlarınız bu sürenin üzerine eklenerek sayılmaya devam eder.
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">Toplam Oynama Süresi</label>
            <div class="playtime-inputs-row">
              <div class="playtime-input-wrap">
                <input id="pt-hours-input" type="number" min="0" step="1" class="text-input" value="${hours}" placeholder="0" />
                <span class="playtime-unit">Saat</span>
              </div>
              <div class="playtime-input-wrap">
                <input id="pt-minutes-input" type="number" min="0" max="59" step="1" class="text-input" value="${minutes}" placeholder="0" />
                <span class="playtime-unit">Dakika</span>
              </div>
            </div>
            <div class="playtime-quick-chips">
              <span class="playtime-quick-label">Hızlı Ekle:</span>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="1">+1 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="5">+5 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="10">+10 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="50">+50 sa</button>
              <button type="button" class="quick-chip reset" data-act="pt-reset">Sıfırla</button>
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">Son Aktivite (Seçiniz)</label>
            <select id="pt-last-played-select" class="playtime-select">
              <option value="" ${!lastPlayed ? "selected" : ""}>Belirtilmemiş (Henüz Oynanmadı)</option>
              <option value="Daha önce oynandı (Epic Games)" ${lastPlayed === "Daha önce oynandı (Epic Games)" ? "selected" : ""}>Daha önce oynandı (Epic Games)</option>
              <option value="Bugün" ${lastPlayed === "Bugün" ? "selected" : ""}>Bugün</option>
              <option value="Dün" ${lastPlayed === "Dün" ? "selected" : ""}>Dün</option>
              <option value="Bu hafta" ${lastPlayed === "Bu hafta" ? "selected" : ""}>Bu hafta</option>
              <option value="Bu ay" ${lastPlayed === "Bu ay" ? "selected" : ""}>Bu ay</option>
              <option value="Geçen ay" ${lastPlayed === "Geçen ay" ? "selected" : ""}>Geçen ay</option>
              <option value="6 ay önce" ${lastPlayed === "6 ay önce" ? "selected" : ""}>6 ay önce</option>
              <option value="1 yıl önce veya daha eski" ${lastPlayed === "1 yıl önce veya daha eski" ? "selected" : ""}>1 yıl önce veya daha eski</option>
              ${hasCustomLastPlayed ? `<option value="${esc(lastPlayed)}" selected>Kayıtlı: ${esc(lastPlayed)}</option>` : ""}
            </select>
            <div class="playtime-input-hint">Kütüphane detay kartındaki "Son Aktivite" alanında görüntülenir.</div>
          </div>
        </div>

        <div class="playtime-footer">
          <button class="btn ghost" data-act="close-edit-playtime">Vazgeç</button>
          <button class="btn primary" data-act="save-playtime" data-id="${esc(appName)}">
            ${icon("check", 14)} Kaydet
          </button>
        </div>
      </div>
    </div>
  `;
}

async function saveEditedPlaytime(appName: string): Promise<void> {
  const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
  const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
  const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;

  const hours = Math.max(0, parseInt(hInput?.value || "0", 10) || 0);
  const minutes = Math.max(0, Math.min(59, parseInt(mInput?.value || "0", 10) || 0));
  const totalSeconds = hours * 3600 + minutes * 60;
  const selectedLp = lpSelect?.value?.trim() || "";
  const lastPlayed = selectedLp.length > 0 ? selectedLp : null;

  const saveBtn = document.querySelector<HTMLButtonElement>('[data-act="save-playtime"]');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Kaydediliyor…";
  }

  try {
    const updated = await epicSetPlaytime(appName, totalSeconds, lastPlayed);
    playtimeMap.set(appName, updated);

    // Update Overview drawer if open
    const overviewPtVal = document.getElementById("drawer-stat-playtime");
    if (overviewPtVal) {
      overviewPtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : "Oynanmadı";
    }
    const overviewLpVal = document.getElementById("drawer-stat-last-activity");
    if (overviewLpVal) {
      overviewLpVal.textContent = updated.last_played || "Henüz oynanmadı";
    }

    // Update Manage drawer if open
    const managePtVal = document.getElementById("manage-playtime-val");
    if (managePtVal) {
      managePtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : "Oynanmadı";
    }
    const managePtMeta = document.getElementById("manage-playtime-meta");
    if (managePtMeta) {
      managePtMeta.textContent = updated.session_count
        ? `${updated.session_count} oturum kaydedildi • Son: ${updated.last_played || "Henüz oynanmadı"}`
        : "Bu launcher üzerinden henüz oturum kaydedilmedi";
    }

    // Update card/grid if visible
    const cardBadge = document.querySelector(`.pcard[data-id="${appName}"] .playtime-badge`) as HTMLElement | null;
    if (cardBadge) {
      if (updated.total_seconds > 0) {
        cardBadge.innerHTML = `${icon("clock", 11)} ${fmtPlaytime(updated.total_seconds)}`;
        cardBadge.style.display = "";
      } else {
        cardBadge.style.display = "none";
      }
    }

    toast(
      updated.total_seconds > 0
        ? `Oynama süresi güncellendi: ${fmtPlaytime(updated.total_seconds)}`
        : "Oynama süresi sıfırlandı",
      "ok"
    );
    closeEditPlaytimeModal();
  } catch (err) {
    toast(`Süre kaydedilemedi: ${String(err)}`, "err");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Kaydet";
    }
  }
}

function closeManageModal(): void {
  if (manageRoot) manageRoot.innerHTML = "";
  activeManageSettings = null;
}

async function openManageModal(appName: string): Promise<void> {
  if (!isTauri) {
    toast("Oyun yönetimi yalnızca masaüstü uygulamasında kullanılabilir.", "err");
    return;
  }
  const sum = epicSummaries.find((x) => x.appName === appName);
  const dl = downloads.get(appName);
  const title = sum?.title || dl?.title || appName;
  const version = sum?.installedVersion || sum?.version || "1.0";
  const installPath = sum?.installPath || "";
  const installSize = sum?.installSize || 0;

  // 0ms anında açılış için hızlı yerel verilerle hemen render et
  activeManageSettings = {
    appName,
    title,
    launchParameters: "",
    autoUpdate: true,
    highPriority: false,
    cloudSavesEnabled: true,
    lastCloudSync: null,
    installSize,
    installPath,
    version,
  };
  manageShowArgs = false;
  renderManageModal();

  // Arka planda tam ayarları çek ve dialogu bozmadan yerinde güncelle
  try {
    const st = await epicGetGameSettings(appName);
    if (activeManageSettings && activeManageSettings.appName === appName) {
      activeManageSettings = st;
      updateManageModalInputsInPlace(st);
    }
  } catch (e) {
    toast(`Oyun ayarları alınamadı: ${String(e)}`, "err");
  }

  // Arka planda yedekleri çek ve listeyi güncelle
  epicListBackups(appName)
    .then((b) => {
      gameBackupsMap.set(appName, b);
      const listEl = document.getElementById("manage-backup-list");
      if (listEl && activeManageSettings?.appName === appName) {
        listEl.innerHTML = renderBackupListHtml(appName);
      }
    })
    .catch(() => {});
}

function updateManageModalInputsInPlace(st: GameLocalSettings): void {
  const autoUpdate = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-autoupdate"]');
  if (autoUpdate) autoUpdate.checked = st.autoUpdate;

  const priority = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-priority"]');
  if (priority) priority.checked = st.highPriority;

  const cloud = document.querySelector<HTMLInputElement>('[data-act="manage-toggle-cloud"]');
  if (cloud) cloud.checked = st.cloudSavesEnabled;

  const cloudSub = document.getElementById("manage-cloud-subtitle");
  if (cloudSub) {
    cloudSub.textContent = st.lastCloudSync
      ? `En son eşitleme: ${st.lastCloudSync}`
      : "Oyun ilerlemelerini Epic Online Services (EOS) bulutuna kaydet";
  }

  const hasArgs = Boolean(st.launchParameters && st.launchParameters.trim().length > 0);
  manageShowArgs = hasArgs;
  const argsToggle = document.getElementById("manage-toggle-args-input") as HTMLInputElement | null;
  if (argsToggle) argsToggle.checked = hasArgs;

  const argsContainer = document.getElementById("manage-args-container");
  if (argsContainer) argsContainer.style.display = hasArgs ? "" : "none";

  const argsInput = document.getElementById("manage-args-input") as HTMLInputElement | null;
  if (argsInput) argsInput.value = st.launchParameters || "";

  const installTitle = document.getElementById("manage-install-title");
  if (installTitle) installTitle.textContent = `Yükleme • ${fmtBytes(st.installSize)}`;

  const installPath = document.getElementById("manage-install-path");
  if (installPath) installPath.textContent = st.installPath;

  const headSub = document.getElementById("manage-head-sub");
  if (headSub) headSub.textContent = `Yönet & Özellikler • v${st.version}`;
}

function updateVerifyProgressInPlace(
  id: string,
  current: number,
  total: number,
  percent: number,
  speed: string,
  detail?: string,
): void {
  const displayDetail = detail || (total > 0 ? `${current}/${total} (%${Math.round(percent)}%)` : `%${Math.round(percent)}%`);
  verifyingMap.set(id, { current, total, percent, speed, detail: displayDetail });
  if (!activeManageSettings || activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  const fill = document.getElementById("manage-verify-fill");
  const count = document.getElementById("manage-verify-count");
  const spd = document.getElementById("manage-verify-speed");
  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Doğrulanıyor…";
  }

  if (fill && count && spd) {
    fill.style.width = `${percent}%`;
    count.textContent = displayDetail;
    spd.textContent = speed;
  } else if (container) {
    container.innerHTML = `
      <div class="verify-box">
        <div class="verify-bar">
          <div id="manage-verify-fill" class="verify-fill" style="width:${percent}%"></div>
        </div>
        <div class="verify-meta">
          <span id="manage-verify-count">${displayDetail}</span>
          <span id="manage-verify-speed">${esc(speed)}</span>
        </div>
      </div>
    `;
  }
}

function resetVerifyInPlace(id: string): void {
  verifyingMap.delete(id);
  if (!activeManageSettings || activeManageSettings.appName !== id) return;

  const container = document.getElementById("manage-verify-box-container");
  if (container) container.innerHTML = "";

  const btn = document.getElementById("manage-verify-btn") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Doğrula";
  }
}

function renderBackupListHtml(appName: string): string {
  const list = gameBackupsMap.get(appName) || [];
  if (list.length === 0) {
    return `<div style="color:#64748b;font-size:12px;padding:6px 0">Henüz yerel kayıt yedeği alınmamış.</div>`;
  }
  return list
    .map(
      (b) => `
    <div class="backup-item">
      <div class="backup-item-meta">
        <span class="backup-item-title">${esc(b.formatted_date)}</span>
        <span class="backup-item-sub">${b.file_count} dosya • ${fmtBytes(b.size_bytes)}</span>
      </div>
      <div class="backup-item-actions">
        <button class="btn ghost small" data-act="manage-restore-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="Bu Yedeği Geri Yükle">
          Geri Yükle
        </button>
        <button class="btn ghost small" data-act="manage-delete-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="Yedeği Sil" style="color:#ef4444">
          ${icon("trash", 12)}
        </button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderManageModal(): void {
  if (!manageRoot || !activeManageSettings) return;
  const st = activeManageSettings;
  const v = verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);
  const pt = playtimeMap.get(st.appName);

  manageRoot.innerHTML = `
    <div class="manage-overlay" data-act="manage-overlay-close">
      <div class="manage-dialog">
        <div class="manage-head">
          <div class="manage-head-title-group">
            <div id="manage-head-title" class="manage-head-title">${esc(st.title)}</div>
            <div id="manage-head-sub" class="manage-head-sub">Yönet &amp; Özellikler • v${esc(st.version)}</div>
          </div>
          <button class="manage-head-close" data-act="manage-close" title="Kapat">${icon("x", 16)}</button>
        </div>
        <div class="manage-body">
          <!-- 0. Oynama İstatistikleri -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#38bdf8">${icon("clock", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Oynama İstatistikleri</div>
                <div class="manage-subtitle">
                  Toplam Süre: <strong style="color:#fff">${fmtPlaytime(pt?.total_seconds || 0)}</strong> • Oturum Sayısı: <strong style="color:#fff">${pt?.session_count || 0}</strong> • Son: <strong style="color:#fff">${pt?.last_played || "Henüz oynanmadı"}</strong>
                </div>
              </div>
            </div>
          </div>

          <!-- 1. Dosyaları Doğrula -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#60a5fa">${icon("shield", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Dosyaları Doğrula</div>
                <div class="manage-subtitle">Oyun dosyalarının bütünlüğünü kontrol et ve eksik/hasarlı parçaları onar</div>
                <div id="manage-verify-box-container">
                  ${
                    isVerifying && v
                      ? `
                    <div class="verify-box">
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
            <div class="manage-right">
              <button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${st.appName}" ${isVerifying ? "disabled" : ""}>
                ${isVerifying ? "Doğrulanıyor…" : "Doğrula"}
              </button>
            </div>
          </div>

          <!-- 2. Otomatik Güncelleme -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#34d399">${icon("refresh", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Otomatik Güncelleme</div>
                <div class="manage-subtitle">Oyun için yeni bir güncelleme yayınlandığında otomatik indir</div>
              </div>
            </div>
            <div class="manage-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-autoupdate" ${st.autoUpdate ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 3. Öncelikli İndirmeler -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#f59e0b">${icon("zap", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Öncelikli İndirmeler</div>
                <div class="manage-subtitle">Bu oyunun güncellemelerini ve indirmelerini kuyrukta en öne al</div>
              </div>
            </div>
            <div class="manage-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-priority" ${st.highPriority ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 4. Bulut Kayıtları -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#38bdf8">${icon("cloud", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Bulut Kayıtları (Cloud Saves)</div>
                <div id="manage-cloud-subtitle" class="manage-subtitle">
                  ${
                    manageSyncingSaves
                      ? "Bulut ile eşitleniyor…"
                      : st.lastCloudSync
                        ? `En son eşitleme: ${esc(st.lastCloudSync)}`
                        : "Oyun ilerlemelerini Epic Online Services (EOS) bulutuna kaydet"
                  }
                </div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="Şimdi Eşitle" ${manageSyncingSaves ? "disabled" : ""}>
                ${icon("refresh", 13)} Eşitle
              </button>
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-cloud" ${st.cloudSavesEnabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <!-- 4.1. Yerel Kayıt Yedekleme (Save Backup Manager) -->
          <div class="manage-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-left">
                <div class="manage-icon" style="color:#a855f7">${icon("hard-drive", 20)}</div>
                <div class="manage-info">
                  <div class="manage-title">Kayıt Dosyaları &amp; Yerel Yedekleme</div>
                  <div class="manage-subtitle">İlerlemenizi korumak için oyun kayıtlarını (save) yerel olarak arşivleyin ve geri yükleyin</div>
                </div>
              </div>
              <div class="manage-right" style="display:flex;gap:6px;align-items:center">
                <button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${st.appName}" title="Yedek Klasörünü Aç">
                  ${icon("folder", 13)} Klasör
                </button>
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${isBackingUp ? "disabled" : ""}>
                  ${isBackingUp ? "Yedekleniyor…" : "Yedek Al"}
                </button>
              </div>
            </div>
            <div id="manage-backup-list" class="backup-list">
              ${renderBackupListHtml(st.appName)}
            </div>
          </div>

          <!-- 5. Masaüstü Kısayolu Oluştur -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#a78bfa">${icon("monitor", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Masaüstü Kısayolu Oluştur</div>
                <div class="manage-subtitle">Oyunu masaüstünden tek tıkla doğrudan başlatmak için kısayol simgesi ekle</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="manage-create-shortcut" data-id="${st.appName}">
                Oluştur
              </button>
            </div>
          </div>

          <!-- 6. Yükleme (Boyut & Klasör & Kaldır) -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#e2e8f0">${icon("hard-drive", 20)}</div>
              <div class="manage-info">
                <div id="manage-install-title" class="manage-title">Yükleme • ${fmtBytes(st.installSize)}</div>
                <div id="manage-install-path" class="manage-subtitle" style="word-break:break-all;opacity:0.8">${esc(st.installPath)}</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="epic-open-folder" data-id="${st.appName}" title="Kurulum Klasörünü Aç">
                ${icon("folder", 13)} Klasör
              </button>
              <button class="btn danger small" data-act="epic-uninstall" data-id="${st.appName}" title="Oyunu Kaldır">
                ${icon("trash", 13)} Kaldır
              </button>
            </div>
          </div>

          <!-- 7. Eklentiler & DLC -->
          <div class="manage-row">
            <div class="manage-left">
              <div class="manage-icon" style="color:#00e5ff">${icon("layers", 20)}</div>
              <div class="manage-info">
                <div class="manage-title">Eklentiler &amp; DLC</div>
                <div class="manage-subtitle">Oyun eklentilerini ve ek içerik paketlerini yönet</div>
              </div>
            </div>
            <div class="manage-right">
              <button class="btn ghost small" data-act="open-dlc-manager" data-id="${st.appName}">
                Eklentileri Yönet
              </button>
            </div>
          </div>

          <!-- 8. Gelişmiş Başlatma Seçenekleri -->
          <div class="manage-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-left">
                <div class="manage-icon" style="color:#fb7185">${icon("terminal", 20)}</div>
                <div class="manage-info">
                  <div class="manage-title">Gelişmiş Başlatma Seçenekleri</div>
                  <div class="manage-subtitle">Oyuna özel başlatma parametreleri ekleyin (-dx11, -novid, -high vb.)</div>
                </div>
              </div>
              <div class="manage-right">
                <label class="toggle-switch">
                  <input id="manage-toggle-args-input" type="checkbox" data-act="manage-toggle-args-panel" ${manageShowArgs ? "checked" : ""} />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>
            <div id="manage-args-container" style="${manageShowArgs ? "" : "display:none;"}">
              <div class="args-panel">
                <input id="manage-args-input" class="args-input" value="${esc(st.launchParameters || "")}" placeholder="-dx11 -windowed -novid" spellcheck="false" autocomplete="off" />
                <button class="btn primary small" data-act="manage-save-args" data-id="${st.appName}">
                  Kaydet
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ---------- Epic indirme ---------- */

function epicDlProgress(appName: string): number | null {
  const dl = downloads.get(appName);
  return dl && !dl.done ? dl.progress : null;
}

function epicActionButtons(s: EpicSummary, size: "full" | "small" | ""): string {
  const btn = size ? ` ${size}` : "";
  const p = epicDlProgress(s.appName);
  if (p !== null) {
    return `<button class="btn primary${btn}" disabled data-dlbtn="${s.appName}">%${p}</button>
      <button class="btn danger small" data-act="epic-cancel" data-id="${s.appName}">İptal</button>`;
  }
  const isRunning = runningGames.has(s.appName);
  if (isRunning) {
    return `<button class="btn primary${btn} running" data-act="epic-play" data-id="${s.appName}" title="Oyun Çalışıyor"><span class="running-dot"></span> Oynanıyor…</button>`;
  }
  if (s.installed) {
    const hasUpdate = s.updateAvailable || availableUpdates.has(s.appName);
    if (hasUpdate) {
      return `<button class="btn primary${btn}" data-act="epic-install" data-id="${s.appName}" title="Güncellemeyi İndir">${icon("download", 14)} Güncelle</button>`;
    }
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}">${icon("play", 14)} Oyna</button>`;
  }
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);
  if (partner) {
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}" title="${esc(partner.name)} ile Başlat">${icon("external", 14)} ${esc(partner.shortName)}</button>`;
  }
  return `<button class="btn primary${btn}" data-act="epic-install" data-id="${s.appName}">${icon("download", 14)} Yükle</button>`;
}

async function epicInstall(appName: string): Promise<void> {
  const s = epicSummaries.find((x) => x.appName === appName);
  if (!s || epicDlProgress(appName) !== null) return;
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  if (partner) {
    void epicPlay(appName);
    return;
  }
  downloads.set(appName, { progress: 0, done: false, title: s.title });
  if (!activeDlMetrics || activeDlMetrics.done) {
    activeDlMetrics = {
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
    dlQueueStatus = q;
    if (view === "library" || view === "downloads") render();
  }).catch(() => {
    if (view === "library" || view === "downloads") render();
  });
  try {
    const msg = await epicInstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    downloads.delete(appName);
    if (activeDlMetrics?.id === appName) activeDlMetrics = null;
    updateBadge();
    toast(String(e), "err");
    if (view === "library" || view === "downloads") render();
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
    epicSummaries = summarize(epicGamesRaw, einstalled, eskipped);
    pruneRecent();
    epicSkippedCount = eskipped.length;
    if (view === "library") render();
    void refreshUpdates();
  } catch (e) {
    toast(`Kurulu listesi tazelenemedi: ${String(e)}`, "err");
  }
}

let epicSettingsCache: EpicSettings | null = null;
let epicDefaultDir = "";
let eglDetectedList: EglDetectedGame[] = [];
let eglSyncing = false;

async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, eglList, sgdbKey] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
        epicGetSteamGridKey().catch(() => null),
      ]);
      epicSettingsCache = st;
      epicDefaultDir = dir;
      eglDetectedList = eglList;
      steamGridApiKey = sgdbKey;
    } catch {
      // sessiz geç
    }
  }
  render();
}

/* ---------- Koleksiyon Yönetimi (UI & Modallar) ---------- */

const collectionRoot = document.getElementById("collection-root");
let activeEditingColId: string | null = null;
const POPULAR_COL_EMOJIS = [
  "🎮", "📖", "🌐", "🏆", "⚔️", "🚗", "👻", "⚡",
  "🧩", "🚀", "🔫", "🕹️", "🔥", "👑", "🌟", "💎",
  "🛡️", "💀", "🏹", "🧙", "👾", "🤖", "🏎️", "⚽",
  "🏀", "🌍", "📦", "💾", "⭐", "❤️", "🎯", "🎲",
];

let colModalSelectedApps: Set<string> = new Set();
let colModalSearchQuery: string = "";
let colModalSelectedEmoji: string = "";
let colModalTabFilter: "all" | "selected" | "installed" = "all";
let isEmojiPaletteOpen: boolean = false;

function openCollectionModal(colId?: string | null): void {
  activeEditingColId = colId ?? null;
  colModalSearchQuery = "";
  colModalTabFilter = "all";
  isEmojiPaletteOpen = false;
  if (colId) {
    const col = epicCollections.find((c) => c.id === colId);
    colModalSelectedApps = new Set(col?.app_names || []);
    colModalSelectedEmoji = col?.emoji || "";
  } else {
    colModalSelectedApps = new Set();
    colModalSelectedEmoji = "";
  }
  renderCollectionModal();
}

function closeCollectionModal(): void {
  if (collectionRoot) collectionRoot.innerHTML = "";
  activeEditingColId = null;
  gameColModalAppName = null;
  isEmojiPaletteOpen = false;
}

function updateEmojiUi(): void {
  const display = document.getElementById("col-emoji-display");
  const avatarBtn = document.querySelector(".col-emoji-avatar-btn");
  const headerAvatar = document.getElementById("col-header-avatar");
  if (display) {
    display.innerHTML = colModalSelectedEmoji ? esc(colModalSelectedEmoji) : icon("folder", 20);
  }
  if (avatarBtn) {
    avatarBtn.classList.toggle("has-emoji", Boolean(colModalSelectedEmoji));
  }
  if (headerAvatar) {
    headerAvatar.innerHTML = colModalSelectedEmoji
      ? `<span class="col-header-emoji">${esc(colModalSelectedEmoji)}</span>`
      : icon("folder", 18);
  }
  const pal = document.getElementById("col-emoji-palette");
  if (pal) {
    pal.classList.toggle("open", isEmojiPaletteOpen);
    pal.querySelectorAll(".col-emoji-item").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.emoji === colModalSelectedEmoji);
    });
  }
}

function updateColPresetArrows(): void {
  const container = document.getElementById("col-presets-scrollable");
  const wrapper = container?.closest(".col-presets-track-wrapper");
  if (!container || !wrapper) return;

  const leftFade = wrapper.querySelector(".col-presets-fade.left") as HTMLElement | null;
  const rightFade = wrapper.querySelector(".col-presets-fade.right") as HTMLElement | null;

  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = maxScroll > 4;

  const canScrollLeft = hasOverflow && container.scrollLeft > 4;
  const canScrollRight = hasOverflow && container.scrollLeft < maxScroll - 4;

  if (leftFade) leftFade.classList.toggle("visible", canScrollLeft);
  if (rightFade) rightFade.classList.toggle("visible", canScrollRight);
}

function renderCollectionModal(): void {
  if (!collectionRoot) return;
  const col = activeEditingColId ? epicCollections.find((c) => c.id === activeEditingColId) : null;
  const colName = col ? col.name : "";
  const isEditing = Boolean(activeEditingColId);

  const q = colModalSearchQuery.toLocaleLowerCase("tr");
  let filtered = epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
  if (colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => colModalSelectedApps.has(s.appName));
  } else if (colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

  const installedCount = epicSummaries.filter((s) => s.installed).length;
  const selectedCount = colModalSelectedApps.size;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar" id="col-header-avatar">
              ${colModalSelectedEmoji ? `<span class="col-header-emoji">${esc(colModalSelectedEmoji)}</span>` : icon("folder", 20)}
            </div>
            <div>
              <h2>
                <span>${isEditing ? "Koleksiyonu Düzenle" : "Yeni Koleksiyon Oluştur"}</span>
                <span class="col-header-count" id="col-header-selected-badge">${selectedCount} Seçildi</span>
              </h2>
              <div class="col-modal-subtitle">${isEditing ? `"${esc(colName)}" kategorisini özelleştirin` : "Oyunlarınızı kategorilere ayırarak düzenleyin"}</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="Kapat">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="col-modal-body">
          <div class="col-input-group">
            <label for="col-name-input" class="col-label">Koleksiyon Simgesi & Adı</label>
            <div class="col-name-row">
              <div class="col-emoji-picker-container">
                <button type="button" class="col-emoji-avatar-btn ${colModalSelectedEmoji ? "has-emoji" : ""}" data-act="toggle-col-emoji-palette" title="Emoji / Simge Seç">
                  <span id="col-emoji-display">${colModalSelectedEmoji ? esc(colModalSelectedEmoji) : icon("folder", 22)}</span>
                  <span class="col-emoji-edit-badge">${icon("edit", 10)}</span>
                </button>
                <div id="col-emoji-palette" class="col-emoji-palette ${isEmojiPaletteOpen ? "open" : ""}">
                  <div class="col-emoji-palette-header">
                    <span>Bir Simge Seçin</span>
                    ${colModalSelectedEmoji ? `<button type="button" class="col-emoji-clear-btn" data-act="clear-col-emoji">${icon("trash", 11)} Kaldır</button>` : ""}
                  </div>
                  <div class="col-emoji-grid">
                    ${POPULAR_COL_EMOJIS.map((e) => `
                      <button type="button" class="col-emoji-item ${colModalSelectedEmoji === e ? "active" : ""}" data-act="pick-col-emoji" data-emoji="${e}">${e}</button>
                    `).join("")}
                  </div>
                  <div class="col-custom-emoji-row">
                    <input id="col-custom-emoji-input" class="text-input small" placeholder="Farklı bir emoji..." maxlength="4" value="${esc(colModalSelectedEmoji)}" />
                    <button type="button" class="btn ghost small" data-act="apply-custom-emoji">Uygula</button>
                  </div>
                </div>
              </div>
              <input id="col-name-input" class="text-input col-name-input" placeholder="Örn: Hikaye, Online, Co-op, Bitirdiklerim..." value="${esc(colName)}" autocomplete="off" spellcheck="false" />
            </div>

            <!-- Detay Sayfası Tarzı Kaydırılabilir Hızlı Şablonlar -->
            <div class="col-presets-wrapper">
              <span class="col-quick-label">Hızlı Şablonlar:</span>
              <div class="col-presets-track-wrapper">
                <div class="col-presets-fade left">
                  <button type="button" class="col-presets-arrow left" data-act="col-presets-scroll" data-dir="left" title="Sola kaydır">
                    ${icon("chevron-left", 12)}
                  </button>
                </div>
                <div class="col-quick-presets" id="col-presets-scrollable">
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="📖" data-name="Hikaye">📖 Hikaye</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🌐" data-name="Online">🌐 Online</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🏆" data-name="Platin Hedef">🏆 Platin Hedef</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="⚔️" data-name="RPG">⚔️ RPG</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🚗" data-name="Yarış">🚗 Yarış</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="👻" data-name="Korku">👻 Korku</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🔥" data-name="Favoriler">🔥 Favoriler</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="⚡" data-name="Aksiyon">⚡ Aksiyon</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🧩" data-name="Bulmaca">🧩 Bulmaca</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🚀" data-name="Bilim Kurgu">🚀 Bilim Kurgu</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🕹️" data-name="Retro / Klasik">🕹️ Klasik</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="🎯" data-name="Strateji">🎯 Strateji</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="👑" data-name="VIP / Özel">👑 Özel</button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-emoji="📦" data-name="Bitirdiklerim">📦 Bitirdiklerim</button>
                </div>
                <div class="col-presets-fade right">
                  <button type="button" class="col-presets-arrow right" data-act="col-presets-scroll" data-dir="right" title="Sağa kaydır">
                    ${icon("chevron-right", 12)}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="col-picker-box">
            <div class="col-picker-head">
              <div class="col-filter-tabs">
                <button type="button" class="col-filter-tab ${colModalTabFilter === "all" ? "active" : ""}" data-act="col-tab-filter" data-filter="all">
                  Tümü <span class="col-tab-cnt">${epicSummaries.length}</span>
                </button>
                <button type="button" class="col-filter-tab ${colModalTabFilter === "selected" ? "active" : ""}" data-act="col-tab-filter" data-filter="selected">
                  Seçilenler <span class="col-tab-cnt" id="col-tab-selected-cnt">${selectedCount}</span>
                </button>
                <button type="button" class="col-filter-tab ${colModalTabFilter === "installed" ? "active" : ""}" data-act="col-tab-filter" data-filter="installed">
                  Yüklü <span class="col-tab-cnt">${installedCount}</span>
                </button>
              </div>

              <div class="col-quick-btns">
                <button type="button" class="col-quick-btn" data-act="col-select-all">Tümünü Seç</button>
                <button type="button" class="col-quick-btn" data-act="col-deselect-all">Temizle</button>
              </div>
            </div>

            <div class="col-search-wrap">
              <span>${icon("search", 13)}</span>
              <input id="col-search-input" class="text-input" placeholder="Kütüphanedeki ${epicSummaries.length} oyun arasında ara..." value="${esc(colModalSearchQuery)}" autocomplete="off" />
              ${colModalSearchQuery ? `<button type="button" class="col-search-clear" data-act="col-search-clear" title="Temizle">${icon("x", 12)}</button>` : ""}
            </div>

            <div class="col-games-list">
              ${filtered.length > 0 ? filtered.map((s) => {
                const checked = colModalSelectedApps.has(s.appName);
                return `
                  <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
                    <div class="col-custom-cb ${checked ? "checked" : ""}">
                      ${icon("check", 12)}
                    </div>
                    ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
                    <div class="col-game-info">
                      <div class="col-game-title">${esc(s.title)}</div>
                      <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} Yüklü</span>` : "Yüklü Değil"}</div>
                    </div>
                  </div>
                `;
              }).join("") : `<div class="col-empty-msg">Eşleşen oyun bulunamadı.</div>`}
            </div>
          </div>
        </div>

        <div class="col-modal-footer">
          <div>
            ${isEditing ? `<button class="btn danger small" data-act="col-delete-btn" data-col-id="${col!.id}">${icon("trash", 13)} Koleksiyonu Sil</button>` : `<div class="col-footer-summary"><span id="col-footer-count">${selectedCount}</span> / ${epicSummaries.length} oyun seçildi</div>`}
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn ghost small" data-act="close-col-modal">İptal</button>
            <button class="btn primary small" data-act="col-save-btn">${isEditing ? "Değişiklikleri Kaydet" : "Koleksiyon Oluştur"}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  if (nameInput && !isEditing) nameInput.focus();

  const searchInput = document.getElementById("col-search-input") as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      colModalSearchQuery = (e.target as HTMLInputElement).value;
      updateColGamesListInPlace();
    });
  }

  const presetsScrollable = document.getElementById("col-presets-scrollable");
  if (presetsScrollable) {
    presetsScrollable.addEventListener("scroll", updateColPresetArrows, { passive: true });
    requestAnimationFrame(() => updateColPresetArrows());
  }
}

function updateColGamesListInPlace(): void {
  const container = document.querySelector(".col-games-list");
  if (!container) return;
  const q = colModalSearchQuery.toLocaleLowerCase("tr");
  let filtered = epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
  if (colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => colModalSelectedApps.has(s.appName));
  } else if (colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

  container.innerHTML = filtered.length > 0 ? filtered.map((s) => {
    const checked = colModalSelectedApps.has(s.appName);
    return `
      <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
        <div class="col-custom-cb ${checked ? "checked" : ""}">
          ${icon("check", 12)}
        </div>
        ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
        <div class="col-game-info">
          <div class="col-game-title">${esc(s.title)}</div>
          <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} Yüklü</span>` : "Yüklü Değil"}</div>
        </div>
      </div>
    `;
  }).join("") : `<div class="col-empty-msg">Eşleşen oyun bulunamadı.</div>`;

  const selCountEl = document.getElementById("col-tab-selected-cnt");
  if (selCountEl) selCountEl.textContent = String(colModalSelectedApps.size);

  const headerBadge = document.getElementById("col-header-selected-badge");
  if (headerBadge) headerBadge.textContent = `${colModalSelectedApps.size} Seçildi`;

  const footerCnt = document.getElementById("col-footer-count");
  if (footerCnt) footerCnt.textContent = String(colModalSelectedApps.size);
}

async function saveCollectionFromModal(): Promise<void> {
  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || "";
  if (!name) {
    toast("Lütfen koleksiyon adı girin.", "err");
    return;
  }
  try {
    const saved = await epicSaveCollection(
      name,
      Array.from(colModalSelectedApps),
      activeEditingColId,
      colModalSelectedEmoji || null,
    );
    toast(`"${saved.name}" koleksiyonu kaydedildi`, "ok");
    closeCollectionModal();
    await loadEpicCollections();
    render();
  } catch (e) {
    toast(`Koleksiyon kaydedilemedi: ${String(e)}`, "err");
  }
}

async function deleteCollectionFromModal(colId: string): Promise<void> {
  const col = epicCollections.find((c) => c.id === colId);
  const name = col ? col.name : "Koleksiyon";
  if (!confirm(`"${name}" koleksiyonunu silmek istediğinize emin misiniz?\n(Oyunlar silinmez, yalnızca kategori kaldırılır)`)) {
    return;
  }
  try {
    await epicDeleteCollection(colId);
    if (activeCollectionId === colId) activeCollectionId = null;
    toast(`"${name}" koleksiyonu silindi`, "ok");
    closeCollectionModal();
    await loadEpicCollections();
    render();
  } catch (e) {
    toast(`Koleksiyon silinemedi: ${String(e)}`, "err");
  }
}

/* ---------- Oyun Koleksiyonları Seçim Modalı (Detay Çekmecesinden) ---------- */

let gameColModalAppName: string | null = null;
let gameColModalSelectedCols: Set<string> = new Set();

function openGameCollectionsModal(appName: string): void {
  if (!collectionRoot) return;
  gameColModalAppName = appName;
  gameColModalSelectedCols = new Set(
    epicCollections
      .filter((c) => c.app_names.some((a) => a.toLowerCase() === appName.toLowerCase()))
      .map((c) => c.id),
  );

  const sum = epicSummaries.find((s) => s.appName === appName);
  const title = sum?.title || appName;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" style="max-width:540px; height:auto; max-height:75vh;" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar">
              ${icon("folder", 20)}
            </div>
            <div>
              <h2>Koleksiyonlar</h2>
              <div class="col-modal-subtitle">${esc(title)} oyununun dahil olacağı kategoriler</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="Kapat">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="col-modal-body">
          <div class="col-game-checkboxes">
            ${epicCollections.length > 0 ? epicCollections.map((c) => {
              const checked = gameColModalSelectedCols.has(c.id);
              return `
                <div class="col-game-item ${checked ? "selected" : ""}" data-col-id="${esc(c.id)}">
                  <div class="col-custom-cb ${checked ? "checked" : ""}">
                    ${icon("check", 12)}
                  </div>
                  <div class="col-game-info">
                    <div class="col-game-title">
                      ${c.emoji ? `<span class="col-item-emoji">${esc(c.emoji)}</span> ` : ""}${esc(c.name)}
                    </div>
                    <div class="col-game-sub">${c.app_names.length} oyun</div>
                  </div>
                </div>
              `;
            }).join("") : `
              <div class="col-empty-msg">
                Henüz hiç koleksiyon oluşturulmamış.<br/>
                <button class="btn ghost small" data-act="open-new-collection-modal" style="margin-top:8px">+ Yeni Koleksiyon Oluştur</button>
              </div>
            `}
          </div>
        </div>
        <div class="col-modal-footer">
          <button class="btn ghost small" data-act="open-new-collection-modal">+ Yeni Koleksiyon</button>
          <div style="display:flex;gap:10px">
            <button class="btn ghost small" data-act="close-col-modal">İptal</button>
            <button class="btn primary small" data-act="save-game-col-btn">Kaydet</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function saveGameCollectionsFromModal(): Promise<void> {
  if (!gameColModalAppName) return;
  const appName = gameColModalAppName;
  const colIds = Array.from(gameColModalSelectedCols);
  try {
    await epicSetGameCollections(appName, colIds);
    toast("Oyun koleksiyonları güncellendi", "ok");
    closeCollectionModal();
    await loadEpicCollections();
    if (currentModalAppName === appName) {
      updateDrawerCollectionsBoxInPlace(appName);
    }
    render();
  } catch (e) {
    toast(`Koleksiyonlar güncellenemedi: ${String(e)}`, "err");
  }
}

function updateDrawerCollectionsBoxInPlace(appName: string): void {
  const container = document.getElementById("drawer-col-chips-container");
  const subEl = document.getElementById("drawer-col-subtitle");
  const editBtn = document.querySelector<HTMLElement>(".drawer-col-edit-btn span");
  if (!container) return;
  const gameCols = epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === appName.toLowerCase()),
  );
  if (subEl) {
    subEl.textContent = gameCols.length > 0 ? `${gameCols.length} kategoride ekli` : "Kategori atanmadı";
  }
  if (editBtn) {
    editBtn.textContent = gameCols.length > 0 ? "Düzenle" : "+ Ekle";
  }
  container.innerHTML =
    gameCols.length > 0
      ? gameCols
          .map(
            (c) => `
          <button class="bento-col-pill drawer-col-pill" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(c.name)} koleksiyonunu kütüphanede göster">
            ${c.emoji ? `<span class="col-pill-emoji">${esc(c.emoji)}</span>` : `<span class="col-pill-dot"></span>`}
            <span class="col-pill-text">${esc(c.name)}</span>
          </button>
        `,
          )
          .join("")
      : `
          <button class="bento-empty-col" data-act="manage-game-collections" data-id="${appName}">
            <span>Kategori atanmadı</span>
          </button>
        `;
}

/* ---------- Olaylar (delegation) ---------- */

document.addEventListener("click", (e) => {
  // Sıralama açılır menüsü dışına tıklanırsa kapat
  if (isSortDropdownOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".sort-dropdown-container")) {
      isSortDropdownOpen = false;
      const menu = document.getElementById("sort-dropdown-menu");
      if (menu) menu.classList.remove("show");
    }
  }

  // Koleksiyon açılır menüsü dışına tıklanırsa kapat
  if (isColDropdownOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".col-dropdown-container")) {
      isColDropdownOpen = false;
      const menu = document.getElementById("col-dropdown-menu");
      if (menu) menu.classList.remove("show");
    }
  }

  // Emoji paleti dışına tıklanırsa kapat
  if (isEmojiPaletteOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".col-emoji-picker-container")) {
      isEmojiPaletteOpen = false;
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
      const nowChecked = !colModalSelectedApps.has(appName);
      if (nowChecked) colModalSelectedApps.add(appName);
      else colModalSelectedApps.delete(appName);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);

      const cntEl = document.getElementById("col-tab-selected-cnt") || document.getElementById("col-selected-count");
      if (cntEl) cntEl.textContent = String(colModalSelectedApps.size);

      const headerBadge = document.getElementById("col-header-selected-badge");
      if (headerBadge) headerBadge.textContent = `${colModalSelectedApps.size} Seçildi`;

      const footerCnt = document.getElementById("col-footer-count");
      if (footerCnt) footerCnt.textContent = String(colModalSelectedApps.size);

      if (colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
      return;
    } else if (colId) {
      const nowChecked = !gameColModalSelectedCols.has(colId);
      if (nowChecked) gameColModalSelectedCols.add(colId);
      else gameColModalSelectedCols.delete(colId);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);
      return;
    }
  }

  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-view]");
  if (!t) return;

  if (t.dataset.view) {
    closeStore();
    view = t.dataset.view as typeof view;
    if (view === "library") void bootEpic();
    if (view === "profile") {
      if (!playerProfileData && !profileLoading) void loadPlayerProfile();
      render();
      return;
    }
    if (view === "downloads") {
      void epicGetQueue().then((q) => {
        dlQueueStatus = q;
        render();
      }).catch(() => render());
      return;
    }
    if (view === "settings") {
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
    if (el === t || el.closest(".drawer-close") || el.closest(".mclose")) closeModal();
  } else if (act === "goto-library") {
    view = "library";
    render();
  } else if (act === "reset-demo") {
    localStorage.removeItem(MOCK_KEY);
    downloads.clear();
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
    profileFilter = t.dataset.val as typeof profileFilter;
    render();
  } else if (act === "profile-search-clear") {
    profileSearchQuery = "";
    render();
  } else if (act === "open-game-from-profile") {
    const appId = t.dataset.id || (t.closest("[data-id]") as HTMLElement)?.dataset.id;
    if (appId) {
      openEpicModal(appId, true);
    }
  } else if (act === "epic-filter" && t.dataset.val) {
    epicFilter = t.dataset.val as typeof epicFilter;
    if (!updateLibraryFilterInPlace()) render();
  } else if (act === "quick-tab" && t.dataset.tab) {
    const tab = t.dataset.tab;
    const hadCustomCol = activeCollectionId !== null && activeCollectionId !== "all" && activeCollectionId !== "fav";
    if (tab === "all") {
      activeCollectionId = null;
      epicFilter = "all";
    } else if (tab === "installed") {
      activeCollectionId = null;
      epicFilter = epicFilter === "installed" ? "all" : "installed";
    } else if (tab === "fav") {
      activeCollectionId = "fav";
      epicFilter = "all";
    } else if (tab === "platinum") {
      activeCollectionId = null;
      epicFilter = epicFilter === "platinum" ? "all" : "platinum";
    } else if (tab === "updates") {
      activeCollectionId = null;
      epicFilter = epicFilter === "updates" ? "all" : "updates";
    }
    isColDropdownOpen = false;
    isSortDropdownOpen = false;
    const hasCustomCol = activeCollectionId !== null && activeCollectionId !== "all" && activeCollectionId !== "fav";
    if (hadCustomCol !== hasCustomCol || !updateLibraryFilterInPlace()) {
      render();
    }
  } else if (act === "toggle-col-dropdown") {
    if (isSortDropdownOpen) {
      isSortDropdownOpen = false;
      const smenu = document.getElementById("sort-dropdown-menu");
      if (smenu) smenu.classList.remove("show");
    }
    isColDropdownOpen = !isColDropdownOpen;
    const menu = document.getElementById("col-dropdown-menu");
    if (menu) {
      menu.classList.toggle("show", isColDropdownOpen);
    } else {
      render();
    }
  } else if (act === "toggle-sort-dropdown") {
    if (isColDropdownOpen) {
      isColDropdownOpen = false;
      const cmenu = document.getElementById("col-dropdown-menu");
      if (cmenu) cmenu.classList.remove("show");
    }
    isSortDropdownOpen = !isSortDropdownOpen;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) {
      menu.classList.toggle("show", isSortDropdownOpen);
    } else {
      render();
    }
  } else if (act === "select-sort") {
    const sortVal = t.dataset.sort as EpicSort;
    isSortDropdownOpen = false;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) menu.classList.remove("show");
    if (sortVal && sortVal !== epicSort) {
      epicSort = sortVal;
      localStorage.setItem("efxlve-sort", epicSort);
      render();
    }
  } else if (act === "clear-collection") {
    activeCollectionId = null;
    isColDropdownOpen = false;
    isSortDropdownOpen = false;
    render();
  } else if (act === "toggle-hero-spotlight") {
    isHeroCollapsed = !isHeroCollapsed;
    localStorage.setItem("efxlve-hero-collapsed", isHeroCollapsed ? "1" : "0");
    render();
  } else if (act === "epic-size" && t.dataset.val) {
    epicCardSize = t.dataset.val as CardSize;
    localStorage.setItem("efxlve-card-size", epicCardSize);
    render();
  } else if (act === "epic-view-grid") {
    epicViewMode = "grid";
    localStorage.setItem("efxlve-view-mode", "grid");
    render();
  } else if (act === "epic-view-shelves") {
    epicViewMode = "shelves";
    localStorage.setItem("efxlve-view-mode", "shelves");
    render();
  } else if (act === "epic-view-list") {
    epicViewMode = "list";
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
    if (target !== activeCoverTarget) {
      activeCoverTarget = target;
      sgdbAssetType = target === "hero" ? "heroes" : "grids";
      sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
      renderCustomCoverModalContent(id);
      if (customCoverActiveTab === "steamgrid" && sgdbSelectedGameId) {
        void loadSteamGridCovers(id, sgdbSelectedGameId);
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
    showModalSgdbInfo = !showModalSgdbInfo;
    if (activeCustomCoverAppName) {
      renderCustomCoverModalContent(activeCustomCoverAppName);
    }
  } else if (act === "open-external-url" && t.dataset.url) {
    void openUrl(t.dataset.url);
  } else if (act === "switch-cover-tab" && t.dataset.tab) {
    customCoverActiveTab = t.dataset.tab as typeof customCoverActiveTab;
    document.querySelectorAll(".cover-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === customCoverActiveTab);
    });
    if (activeCustomCoverAppName) {
      renderCustomCoverModalContent(activeCustomCoverAppName);
    }
  } else if (act === "sgdb-search" && id) {
    const input = document.getElementById("sgdb-search-input") as HTMLInputElement | null;
    if (input) sgdbSearchQuery = input.value;
    void searchAndLoadSteamGrid(id, sgdbSearchQuery);
  } else if (act === "sgdb-select-game" && id && t.dataset.gameId) {
    const gId = parseInt(t.dataset.gameId, 10);
    if (!isNaN(gId)) {
      sgdbSelectedGameId = gId;
      void loadSteamGridCovers(id, gId);
    }
  } else if (act === "sgdb-set-asset-type" && id && t.dataset.type) {
    const type = t.dataset.type as "grids" | "heroes";
    sgdbAssetType = type;
    const target = type === "heroes" ? "hero" : "cover";
    if (target !== activeCoverTarget) {
      activeCoverTarget = target;
      sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
    }
    if (sgdbSelectedGameId) {
      void loadSteamGridCovers(id, sgdbSelectedGameId);
    }
  } else if (act === "sgdb-set-style" && id) {
    sgdbActiveStyle = t.dataset.style || "";
    if (sgdbSelectedGameId) {
      void loadSteamGridCovers(id, sgdbSelectedGameId);
    }
  } else if (act === "sgdb-select-card" && t.dataset.url) {
    sgdbSelectedCoverUrl = t.dataset.url;
    document.querySelectorAll(".sgdb-card").forEach((card) => {
      const isSel = (card as HTMLElement).dataset.url === sgdbSelectedCoverUrl;
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
      previewImg.src = sgdbSelectedCoverUrl;
    } else if (previewWrapper) {
      previewWrapper.innerHTML = `
        <img id="cover-preview-img" src="${esc(sgdbSelectedCoverUrl)}" alt="Önizleme" />
        <div class="cover-preview-badge">Seçilen Önizleme</div>
      `;
    }
    const badge = previewWrapper?.querySelector(".cover-preview-badge");
    if (badge) badge.textContent = "Seçilen Önizleme";
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    if (input) input.value = sgdbSelectedCoverUrl;
  } else if (act === "save-inline-sgdb-key" && id) {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    if (!key) {
      toast("Lütfen geçerli bir SteamGridDB API anahtarı girin", "err");
      return;
    }
    epicSetSteamGridKey(key)
      .then(() => {
        steamGridApiKey = key;
        toast("SteamGridDB API anahtarı kaydedildi", "ok");
        renderCustomCoverModalContent(id);
        void searchAndLoadSteamGrid(id, sgdbSearchQuery);
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "save-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    epicSetSteamGridKey(key)
      .then(() => {
        steamGridApiKey = key || null;
        toast(key ? "SteamGridDB API anahtarı kaydedildi" : "SteamGridDB API anahtarı kaldırıldı", "ok");
        render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "test-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || steamGridApiKey || "";
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
      showSettingsSgdbKey = !showSettingsSgdbKey;
      input.type = showSettingsSgdbKey ? "text" : "password";
      t.innerHTML = icon(showSettingsSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "toggle-modal-sgdb-key-visibility") {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    if (input) {
      showModalSgdbKey = !showModalSgdbKey;
      input.type = showModalSgdbKey ? "text" : "password";
      t.innerHTML = icon(showModalSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "preview-custom-cover-url") {
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    const val = input?.value.trim();
    if (val) {
      sgdbSelectedCoverUrl = val;
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
    const val = sgdbSelectedCoverUrl || input?.value.trim() || "";
    if (val) {
      if (activeCoverTarget === "hero") {
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
    if (activeCoverTarget === "hero") {
      resetCustomHero(id);
      toast("Yatay afiş orijinal haline döndürüldü", "ok");
    } else {
      resetCustomCover(id);
      toast("Dikey kapak orijinal haline döndürüldü", "ok");
    }
    sgdbSelectedCoverUrl = "";
    renderCustomCoverModalFrame(id);
    renderCustomCoverModalContent(id);
  } else if (act === "reset-all-art" && id) {
    resetCustomCover(id);
    resetCustomHero(id);
    sgdbSelectedCoverUrl = "";
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
      activeCollectionId = null;
      if (epicFilter === "fav") epicFilter = "all";
    } else if (colId === "fav") {
      activeCollectionId = "fav";
      epicFilter = "all";
    } else if (colId) {
      activeCollectionId = colId;
      if (epicFilter === "fav") epicFilter = "all";
    }
    isColDropdownOpen = false;
    if (currentModalAppName) closeModal();
    render();
  } else if (act === "open-new-collection-modal") {
    isColDropdownOpen = false;
    openCollectionModal();
  } else if (act === "edit-collection") {
    isColDropdownOpen = false;
    const colId = t.dataset.colId;
    if (colId) openCollectionModal(colId);
  } else if (act === "close-col-modal") {
    closeCollectionModal();
  } else if (act === "col-modal-backdrop") {
    if (e.target === t) closeCollectionModal();
  } else if (act === "toggle-col-emoji-palette") {
    isEmojiPaletteOpen = !isEmojiPaletteOpen;
    const pal = document.getElementById("col-emoji-palette");
    if (pal) pal.classList.toggle("open", isEmojiPaletteOpen);
  } else if (act === "pick-col-emoji") {
    const emoji = t.dataset.emoji;
    if (emoji) {
      colModalSelectedEmoji = emoji;
      isEmojiPaletteOpen = false;
      updateEmojiUi();
    }
  } else if (act === "clear-col-emoji") {
    colModalSelectedEmoji = "";
    isEmojiPaletteOpen = false;
    updateEmojiUi();
  } else if (act === "apply-custom-emoji") {
    const customInput = document.getElementById("col-custom-emoji-input") as HTMLInputElement | null;
    const val = customInput?.value.trim() || "";
    if (val) {
      colModalSelectedEmoji = val;
      isEmojiPaletteOpen = false;
      updateEmojiUi();
    }
  } else if (act === "quick-col-preset") {
    const presetEmoji = t.dataset.emoji;
    const presetName = t.dataset.name;
    if (presetEmoji) {
      colModalSelectedEmoji = presetEmoji;
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
      colModalTabFilter = filter;
      document.querySelectorAll(".col-filter-tab").forEach((tab) => {
        tab.classList.toggle("active", (tab as HTMLElement).dataset.filter === filter);
      });
      updateColGamesListInPlace();
    }
  } else if (act === "col-search-clear") {
    colModalSearchQuery = "";
    const sInput = document.getElementById("col-search-input") as HTMLInputElement | null;
    if (sInput) {
      sInput.value = "";
      sInput.focus();
    }
    updateColGamesListInPlace();
  } else if (act === "col-toggle-game") {
    const app = t.dataset.app || (t.closest(".col-game-item") as HTMLElement)?.dataset.app;
    if (app) {
      if (colModalSelectedApps.has(app)) {
        colModalSelectedApps.delete(app);
      } else {
        colModalSelectedApps.add(app);
      }
      const itemEl = (t.classList.contains("col-game-item") ? t : t.closest(".col-game-item")) as HTMLElement | null;
      const isChecked = colModalSelectedApps.has(app);
      const cb = itemEl?.querySelector(".col-game-cb") as HTMLInputElement | null;
      if (cb) cb.checked = isChecked;
      if (itemEl) itemEl.classList.toggle("selected", isChecked);

      const selCountEl = document.getElementById("col-tab-selected-cnt");
      if (selCountEl) selCountEl.textContent = String(colModalSelectedApps.size);

      if (colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
    }
  } else if (act === "col-select-all") {
    const q = colModalSearchQuery.toLocaleLowerCase("tr");
    let matches = epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
    if (colModalTabFilter === "installed") {
      matches = matches.filter((s) => s.installed);
    }
    matches.forEach((s) => colModalSelectedApps.add(s.appName));
    updateColGamesListInPlace();
  } else if (act === "col-deselect-all") {
    if (colModalTabFilter === "all" && !colModalSearchQuery.trim()) {
      colModalSelectedApps.clear();
    } else {
      const q = colModalSearchQuery.toLocaleLowerCase("tr");
      let matches = epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
      if (colModalTabFilter === "installed") {
        matches = matches.filter((s) => s.installed);
      }
      matches.forEach((s) => colModalSelectedApps.delete(s.appName));
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
        if (view === "settings") void loadSettingsView();
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
    activeDrawerTab = "dlcs";
    if (!dlcCache.has(id) && !dlcLoading) {
      dlcLoading = true;
      epicGetGameDlcs(id)
        .then((res) => {
          dlcCache.set(id, res);
          if (activeDrawerTab === "dlcs" && currentModalAppName === id) {
            openEpicModal(id, false);
          }
        })
        .catch(() => {})
        .finally(() => {
          dlcLoading = false;
          if (activeDrawerTab === "dlcs" && currentModalAppName === id) {
            openEpicModal(id, false);
          }
        });
    }
    openEpicModal(id, false);
  } else if (act === "dlc-back") {
    view = "library";
    render();
  } else if (act === "dlc-discover-store" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
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
    const tags = Array.from(selectedInstallTags);
    const dlcs = Array.from(selectedDlcAppIds);
    void applySelectiveInstall(id, tags, dlcs);
  } else if (act === "epic-save-install-dir") {
    const input = document.getElementById("epic-install-dir") as HTMLInputElement | null;
    const v = input?.value?.trim() ?? "";
    epicSetInstallDir(v ? v : null)
      .then((st: EpicSettings) => {
        epicSettingsCache = st;
        toast("Kurulum klasörü kaydedildi", "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "epic-sync-egl") {
    if (eglSyncing) return;
    eglSyncing = true;
    render();
    epicSyncEglInstalled()
      .then(async (synced) => {
        await refreshEpicInstalled();
        eglDetectedList = await epicDetectEglGames().catch(() => []);
        toast(synced > 0 ? `${synced} oyun eşitlendi ve kütüphaneye eklendi!` : "Tüm oyunlar zaten eşitlenmiş durumda.", "ok");
      })
      .catch((e: unknown) => toast(`Eşitleme hatası: ${String(e)}`, "err"))
      .finally(() => {
        eglSyncing = false;
        render();
      });
  } else if (act === "epic-refresh-egl") {
    void loadSettingsView();
  } else if (act === "manage-game" && id) {
    activeDrawerTab = "manage";
    openEpicModal(id, false);
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
  } else if (act === "manage-sync-saves" && id && !manageSyncingSaves) {
    manageSyncingSaves = true;
    const syncBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-sync-saves"]');
    const cloudSub = document.getElementById("manage-cloud-subtitle");
    if (syncBtn) syncBtn.disabled = true;
    if (cloudSub) cloudSub.textContent = "Bulut ile eşitleniyor…";
    epicSyncSaves(id)
      .then((msg) => {
        toast(msg, "ok");
        const now = new Date().toLocaleString("tr-TR");
        if (activeManageSettings && activeManageSettings.appName === id) {
          activeManageSettings.lastCloudSync = now;
        }
        if (cloudSub) cloudSub.textContent = `En son eşitleme: ${now}`;
      })
      .catch((err) => {
        toast(`Bulut eşitleme hatası: ${String(err)}`, "err");
        if (cloudSub && activeManageSettings) {
          cloudSub.textContent = activeManageSettings.lastCloudSync
            ? `En son eşitleme: ${esc(activeManageSettings.lastCloudSync)}`
            : "Oyun ilerlemelerini Epic Online Services (EOS) bulutuna kaydet";
        }
      })
      .finally(() => {
        manageSyncingSaves = false;
        if (syncBtn) syncBtn.disabled = false;
      });
  } else if (act === "manage-create-shortcut" && id) {
    epicCreateDesktopShortcut(id)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(`Kısayol oluşturulamadı: ${String(err)}`, "err"));
  } else if (act === "manage-create-backup" && id && !isBackingUp) {
    isBackingUp = true;
    const createBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Yedekleniyor…"; }
    toast("Kayıtlar yerel olarak yedekleniyor…", "");
    epicBackupSave(id)
      .then((b) => {
        toast(`Yedek alındı: ${fmtBytes(b.size_bytes)} (${b.file_count} dosya)`, "ok");
        const cur = gameBackupsMap.get(id) || [];
        gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
        const listEl = document.getElementById("manage-backup-list");
        if (listEl) listEl.innerHTML = renderBackupListHtml(id);
      })
      .catch((err) => toast(`Yedekleme hatası: ${String(err)}`, "err"))
      .finally(() => {
        isBackingUp = false;
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
          const cur = gameBackupsMap.get(id) || [];
          gameBackupsMap.set(id, cur.filter((x) => x.id !== bid));
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
    offlineMode = !offlineMode;
    updateOfflineModeUi();
    void epicSetOfflineMode(offlineMode);
    toast(offlineMode ? "Çevrimdışı moda geçildi" : "Çevrimiçi moda geçildi", "ok");
    render();
  } else if (act === "set-net-profile") {
    const prof = t.dataset.profile;
    if (prof) {
      networkProfile = prof;
      void epicSetNetworkProfile(prof);
      const label = prof === "max" ? "Maksimum Hız (16 Worker)" : prof === "low" ? "Düşük Tüketim (1 Worker)" : "Dengeli (4 Worker)";
      toast(`İndirme profili: ${label}`, "ok");
      render();
    }
  } else if (act === "manage-save-args" && id && activeManageSettings) {
    const input = document.getElementById("manage-args-input") as HTMLInputElement | null;
    const val = input?.value?.trim() ?? "";
    activeManageSettings.launchParameters = val;
    epicSaveGameSettings(activeManageSettings)
      .then(() => toast("Başlatma parametreleri kaydedildi", "ok"))
      .catch((err) => toast(`Kayıt hatası: ${String(err)}`, "err"));
  } else if (act === "dl-pause" && id) {
    epicPauseDownload(id)
      .then((msg) => {
        dlQueueStatus.isPaused = true;
        toast(msg, "");
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-resume" && id) {
    epicResumeDownload(id)
      .then((msg) => {
        dlQueueStatus.isPaused = false;
        toast(msg, "");
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-up" && id) {
    epicReorderQueue(id, "up")
      .then((q) => {
        dlQueueStatus = q;
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-down" && id) {
    epicReorderQueue(id, "down")
      .then((q) => {
        dlQueueStatus = q;
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-now" && id) {
    epicReorderQueue(id, "now")
      .then((q) => {
        dlQueueStatus = q;
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-remove" && id) {
    epicReorderQueue(id, "remove")
      .then((q) => {
        dlQueueStatus = q;
        toast("Kuyruktan kaldırıldı", "");
        if (view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "epic-open-folder" && id) {
    void epicOpenFolder(id);
  } else if (act === "epic-store-page" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    void openStoreUrl(epicStorePageUrl(title), "store");
  } else if (act === "drawer-tab") {
    const tab = t.dataset.tab as DrawerTab;
    if (tab && currentModalAppName) {
      if (tab === activeDrawerTab) return;
      activeDrawerTab = tab;
      if (tab === "achievements") {
        const cached = loadedAchievements.get(currentModalAppName);
        if (!cached || cached.achievements.length === 0) {
          void fetchAndRenderAchievements(currentModalAppName, true);
        }
      } else if (tab === "dlcs") {
        if (!dlcCache.has(currentModalAppName) && !dlcLoading) {
          dlcLoading = true;
          epicGetGameDlcs(currentModalAppName)
            .then((res) => {
              dlcCache.set(currentModalAppName!, res);
              if (activeDrawerTab === "dlcs" && currentModalAppName) {
                openEpicModal(currentModalAppName, false, true);
              }
            })
            .catch(() => {})
            .finally(() => {
              dlcLoading = false;
              if (activeDrawerTab === "dlcs" && currentModalAppName) {
                openEpicModal(currentModalAppName, false, true);
              }
            });
        }
      } else if (tab === "manage") {
        if (!gameBackupsMap.has(currentModalAppName)) {
          epicListBackups(currentModalAppName)
            .then((b) => {
              gameBackupsMap.set(currentModalAppName!, b);
              const listEl = document.getElementById("manage-backup-list");
              if (listEl && currentModalAppName) {
                listEl.innerHTML = renderBackupListHtml(currentModalAppName);
              }
            })
            .catch(() => {});
        }
      } else if (tab === "specs") {
        if (!loadedRequirements.has(currentModalAppName)) {
          const s = epicSummaries.find((x) => x.appName === currentModalAppName);
          if (s) void fetchAndRenderRequirements(currentModalAppName, s.title);
        }
      }
      openEpicModal(currentModalAppName, false, true);
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
    if (val && currentModalAppName) {
      if (activeSystemPlatform === val) return;
      activeSystemPlatform = val;
      openEpicModal(currentModalAppName, false, false);
    }
  } else if (act === "req-refresh" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
    if (s) void fetchAndRenderRequirements(id, s.title, true);
  } else if (act === "open-store-achievements" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    const url = epicAchievementsUrl(title, id);
    void openStoreUrl(url, "store");
  } else if (act === "clear-ach-search") {
    achSearchQuery = "";
    if (currentModalAppName) {
      openEpicModal(currentModalAppName, false, false);
    }
  } else if (act === "ach-filter") {
    const val = t.dataset.val as "all" | "unlocked" | "locked" | "hidden";
    if (val && currentModalAppName) {
      if (activeAchFilter === val) return;
      activeAchFilter = val;
      openEpicModal(currentModalAppName, false, false);
    }
  } else if (act === "ach-scope") {
    const val = t.dataset.val as "all" | "base" | "dlc";
    if (val && currentModalAppName) {
      if (activeAchScope === val) return;
      activeAchScope = val;
      openEpicModal(currentModalAppName, false, false);
    }
  } else if (act === "ach-reveal") {
    const achName = t.dataset.ach;
    if (achName && currentModalAppName) {
      const key = `${currentModalAppName}:${achName}`;
      if (revealedAchievements.has(key)) {
        revealedAchievements.delete(key);
      } else {
        revealedAchievements.add(key);
      }
      openEpicModal(currentModalAppName, false, false);
    }
  } else if (act === "toggle-demo-platinum" && id) {
    if (demoPlatinumApps.has(id)) {
      demoPlatinumApps.delete(id);
      toast("Platin efekti kaldırıldı", "");
    } else {
      demoPlatinumApps.add(id);
      toast("Platin Kupa parıltısı açıldı!", "ok");
    }
    localStorage.setItem(DEMO_PLAT_KEY, JSON.stringify([...demoPlatinumApps]));
    if (view === "library") render();
    if (currentModalAppName === id) openEpicModal(id, false, false);
  } else if (act === "ach-refresh" && id) {
    void fetchAndRenderAchievements(id, true);
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
  if (e.key === "Escape") {
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
    if (selectiveInstallOptions) {
      closeSelectiveModal();
      return;
    }
    if (activeManageSettings) {
      closeManageModal();
      return;
    }
    closeModal();
  }
  if (e.key === "Enter") {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && activeEl.id === "sgdb-search-input" && activeCustomCoverAppName) {
      e.preventDefault();
      searchAndLoadSteamGrid(activeCustomCoverAppName);
      return;
    }
    if (activeEl && activeEl.id === "modal-sgdb-key-input" && activeCustomCoverAppName) {
      e.preventDefault();
      const key = (activeEl as HTMLInputElement).value.trim();
      if (!key) {
        toast("Lütfen geçerli bir SteamGridDB API anahtarı girin", "err");
        return;
      }
      epicSetSteamGridKey(key)
        .then(() => {
          steamGridApiKey = key;
          toast("SteamGridDB API anahtarı kaydedildi", "ok");
          renderCustomCoverModalContent(activeCustomCoverAppName);
          void searchAndLoadSteamGrid(activeCustomCoverAppName, sgdbSearchQuery);
        })
        .catch((err) => toast(String(err), "err"));
      return;
    }
    if (activeEl && activeEl.id === "custom-cover-url-input") {
      e.preventDefault();
      const val = (activeEl as HTMLInputElement).value.trim();
      if (val) {
        sgdbSelectedCoverUrl = val;
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
      sgdbSelectedCoverUrl = result;
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
    achSortOrder = (target as unknown as HTMLSelectElement).value as any;
    if (currentModalAppName) {
      openEpicModal(currentModalAppName, false, false);
    }
    return;
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "ach-search-input" && currentModalAppName) {
    achSearchQuery = (t as HTMLInputElement).value;
    const container = document.getElementById("ach-list-container");
    if (container) {
      const data = loadedAchievements.get(currentModalAppName);
      const s = epicSummaries.find((x) => x.appName === currentModalAppName);
      if (data && s) {
        enrichAchievementsData(s.appName, data);
        const query = achSearchQuery.trim().toLowerCase();
        const isDemo = demoPlatinumApps.has(s.appName);
        const filteredItems = data.achievements.filter((a) => {
          if (activeAchScope === "base" && !a.is_base) return false;
          if (activeAchScope === "dlc" && a.is_base) return false;
          const isUnlocked = a.unlocked || isDemo;
          if (activeAchFilter === "unlocked" && !isUnlocked) return false;
          if (activeAchFilter === "locked" && isUnlocked) return false;
          if (activeAchFilter === "hidden" && !a.hidden) return false;
          if (query) {
            const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
            const matchDesc = (a.description || "").toLowerCase().includes(query);
            if (!matchTitle && !matchDesc) return false;
          }
          return true;
        });
        const sortedItems = [...filteredItems].sort((a, b) => {
          if (achSortOrder === "rarity") {
            const ra = a.rarity?.percent ?? 100;
            const rb = b.rarity?.percent ?? 100;
            return ra - rb;
          }
          if (achSortOrder === "xp") return b.xp - a.xp;
          if (achSortOrder === "date") {
            const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
            const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
            return db - da;
          }
          return 0;
        });
        const hasDlc = data.achievements.some((a) => !a.is_base);
        container.innerHTML = renderAchievementSections(sortedItems, s, hasDlc && activeAchScope === "all");
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
    sgdbSearchQuery = (t as HTMLInputElement).value;
    return;
  }
  if (t.id === "search") {
    query = (t as HTMLInputElement).value;
    const box = document.getElementById("lib-results");
    if (box) box.innerHTML = renderEpicItems();
    return;
  }
  if (t.id === "dlc-search") {
    dlcSearchQuery = (t as HTMLInputElement).value;
    const bodyEl = document.getElementById("dlc-table-body");
    if (bodyEl && activeDlcAppName) {
      const dlcRes = dlcCache.get(activeDlcAppName);
      const allDlcs = dlcRes?.dlcs || [];
      const q = dlcSearchQuery.trim().toLowerCase();
      const filtered = q
        ? allDlcs.filter((d) => d.title.toLowerCase().includes(q))
        : allDlcs;
      bodyEl.innerHTML = renderDlcRows(filtered);
    }
    return;
  }
  if (t.id === "dlc-drawer-search" && currentModalAppName) {
    dlcSearchQuery = (t as HTMLInputElement).value;
    const s = epicSummaries.find((x) => x.appName === currentModalAppName);
    const contentEl = document.getElementById("drawer-tab-content");
    if (s && contentEl && activeDrawerTab === "dlcs") {
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
    profileSearchQuery = (t as HTMLInputElement).value;
    const grid = document.getElementById("profile-games-grid");
    if (grid && playerProfileData) {
      const all = playerProfileData.games || [];
      let filtered = all.filter((g) => {
        if (profileFilter === "platinum") return g.is_platinum || g.unlocked_percent >= 100;
        if (profileFilter === "in_progress") return g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum;
        if (profileFilter === "not_started") return g.unlocked_percent === 0;
        return true;
      });
      if (profileSearchQuery.trim()) {
        const q = profileSearchQuery.trim().toLowerCase();
        filtered = filtered.filter(
          (g) => g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q),
        );
      }
      grid.innerHTML = renderProfileGameCards(filtered);
    }
    return;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "profile-sort-select") {
    profileSort = (t as HTMLSelectElement).value as typeof profileSort;
    render();
    return;
  }
  if (t.id === "epic-sort") {
    epicSort = (t as HTMLSelectElement).value as typeof epicSort;
    render();
    return;
  }
  const act = t.dataset.act;
  if (act === "manage-toggle-autoupdate" && activeManageSettings) {
    activeManageSettings.autoUpdate = (t as HTMLInputElement).checked;
    epicSaveGameSettings(activeManageSettings)
      .then(() => toast(activeManageSettings?.autoUpdate ? "Otomatik güncelleme açıldı" : "Otomatik güncelleme kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-priority" && activeManageSettings) {
    activeManageSettings.highPriority = (t as HTMLInputElement).checked;
    epicSaveGameSettings(activeManageSettings)
      .then(() => toast(activeManageSettings?.highPriority ? "Öncelikli indirme açıldı" : "Öncelikli indirme kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-cloud" && activeManageSettings) {
    activeManageSettings.cloudSavesEnabled = (t as HTMLInputElement).checked;
    epicSaveGameSettings(activeManageSettings)
      .then(() => toast(activeManageSettings?.cloudSavesEnabled ? "Bulut kayıtları açıldı" : "Bulut kayıtları kapatıldı", ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-args-panel") {
    manageShowArgs = (t as HTMLInputElement).checked;
    const container = document.getElementById("manage-args-container");
    if (container) {
      container.style.display = manageShowArgs ? "" : "none";
      if (manageShowArgs) {
        const inp = document.getElementById("manage-args-input") as HTMLInputElement | null;
        inp?.focus();
      }
    }
  } else if (act === "selective-toggle-tag") {
    const tag = t.dataset.tag;
    if (tag) {
      if ((t as HTMLInputElement).checked) {
        selectedInstallTags.add(tag);
      } else {
        selectedInstallTags.delete(tag);
      }
      renderSelectiveModal();
    }
  } else if (act === "selective-toggle-dlc") {
    const dlc = t.dataset.dlc;
    if (dlc) {
      if ((t as HTMLInputElement).checked) {
        selectedDlcAppIds.add(dlc);
      } else {
        selectedDlcAppIds.delete(dlc);
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
            const cached = dlcCache.get(app);
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
            const cached = dlcCache.get(app);
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
  document.getElementById("totop")?.classList.toggle("show", viewEl.scrollTop > 600);
});

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
  if (typeof updateDrawerTabArrows === "function") {
    updateDrawerTabArrows();
  }
  if (typeof updateColPresetArrows === "function") {
    updateColPresetArrows();
  }
  if (view === "downloads" && typeof drawSpeedCanvas === "function") {
    drawSpeedCanvas();
  }
  if (storeVisible) {
    syncStoreViewSize();
    window.clearTimeout(storeResizeTimer);
    storeResizeTimer = window.setTimeout(() => {
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

window.addEventListener("resize", handleWindowResize);

/* ---------- Başlat ---------- */

async function init(): Promise<void> {
  updateMaxIcon();
  if (isTauri) {
    void invoke("app_set_decorations", { decorations: false }).catch(() => {});
  }
  createIcons({
    icons: { Store, LayoutGrid, Download, CircleUserRound, Settings, Gamepad2 },
  });
  if (isTauri) {
    try {
      libraryPath = await invoke<string>("library_dir");
    } catch {
      libraryPath = "alınamadı";
    }
    try {
      epicSkippedCount = (await epicListSkipped()).length;
    } catch {
      epicSkippedCount = 0;
    }
    await listen<SetupEvent>("legendary-setup", (event) => {
      setupProgress = event.payload.progress ?? null;
      setupMessage = event.payload.message;
      if (event.payload.state === "error") toast(setupMessage, "err");
      if (view === "library") render();
    });
    await listen<LibraryEvent>("legendary-library", (event) => {
      epicBusyMsg = event.payload.message;
      if (view === "library") render();
    });
    await listen<DlProgressEvent>("download-progress", (event) => {
      const { id, progress, done, speed, speedBytes, diskSpeed, diskBytes, eta, downloadedBytes, totalBytes } = event.payload;
      const title =
        gameById(id)?.title ?? epicSummaries.find((s) => s.appName === id)?.title ?? id;

      if (!done) {
        const cur = downloads.get(id);
        if (cur) cur.progress = progress;
        else downloads.set(id, { progress, done: false, title });

        if (!activeDlMetrics || activeDlMetrics.id !== id) {
          activeDlMetrics = {
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
          activeDlMetrics.progress = progress;
          if (speed) activeDlMetrics.speed = speed;
          if (speedBytes !== undefined && speedBytes !== null) activeDlMetrics.speedBytes = speedBytes;
          if (diskSpeed) activeDlMetrics.diskSpeed = diskSpeed;
          if (diskBytes !== undefined && diskBytes !== null) activeDlMetrics.diskBytes = diskBytes;
          if (eta) activeDlMetrics.eta = eta;
          if (downloadedBytes) activeDlMetrics.downloadedBytes = downloadedBytes;
          if (totalBytes) activeDlMetrics.totalBytes = totalBytes;
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
        if (view === "downloads") {
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
      downloads.set(id, { progress: 100, done: true, title });
      if (activeDlMetrics?.id === id) {
        activeDlMetrics = null;
      }
      pushSpeedData(0, 0);
      updateBadge();
      void epicGetQueue().then((q) => {
        dlQueueStatus = q;
        render();
      }).catch(() => render());
      if (epicSummaries.some((s) => s.appName === id)) void refreshEpicInstalled();
      else void refreshGames();
    });
    await listen<{ id: string }>("download-paused", (_event) => {
      dlQueueStatus.isPaused = true;
      if (view === "downloads") render();
    });
    await listen<DownloadFailedEvent>("download-failed", (event) => {
      downloads.delete(event.payload.id);
      if (activeDlMetrics?.id === event.payload.id) activeDlMetrics = null;
      updateBadge();
      toast(`İndirme başarısız: ${event.payload.message}`, "err");
      void epicGetQueue().then((q) => {
        dlQueueStatus = q;
        if (view === "downloads" || view === "library") render();
      });
    });
    await listen<DownloadCancelledEvent>("download-cancelled", (event) => {
      downloads.delete(event.payload.id);
      if (activeDlMetrics?.id === event.payload.id) activeDlMetrics = null;
      updateBadge();
      toast("İndirme iptal edildi", "");
      void epicGetQueue().then((q) => {
        dlQueueStatus = q;
        if (view === "downloads" || view === "library") render();
      });
    });
    startSpeedChartTimer();
    window.addEventListener("resize", () => {
      if (view === "downloads") drawSpeedCanvas();
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

    await listen<{ appName?: string; title?: string; slug?: string }>(
      "efxlve-open-game-from-store",
      (event) => {
        const { appName, title, slug } = event.payload;
        closeStore();
        view = "library";
        render();

        let targetApp = appName;
        if (!targetApp && (slug || title)) {
          const normTitle = (title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const match = epicSummaries.find((s) => {
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
          query = q;
          render();
        }
      },
    );

    await listen<GameStatusEvent>("game-status", (event) => {
      const { id, running, sessionSeconds, totalSeconds, sessionCount, lastPlayed, lastPlayedTimestamp } = event.payload;
      const sum = epicSummaries.find((x) => x.appName === id);
      const title = sum?.title || id;

      if (running) {
        runningGames.add(id);
        toast(`${title} çalışıyor…`, "ok");
      } else {
        runningGames.delete(id);
        if (totalSeconds !== undefined) {
          playtimeMap.set(id, {
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

      if (view === "library") {
        render();
      }

      if (activeManageSettings?.appName === id) {
        renderManageModal();
      }
      if (currentModalAppName === id && activeDrawerTab === "overview") {
        openEpicModal(id, false);
      }
    });

    await listen<{ id: string; success: boolean }>("cloud-sync-complete", () => {
      toast("Bulut kayıtları eşitlendi (EOS)", "ok");
      const cloudSub = document.getElementById("manage-cloud-subtitle");
      if (cloudSub) cloudSub.textContent = "Bulut kayıtları güncel";
    });

    try {
      const pt = await epicGetPlaytimes();
      playtimeMap = new Map(Object.entries(pt));
    } catch {
      // ignore
    }
    try {
      offlineMode = await epicGetOfflineMode();
      updateOfflineModeUi();
    } catch {
      // ignore
    }
    try {
      networkProfile = await epicGetNetworkProfile();
    } catch {
      // ignore
    }
  }
  await refreshGames();
  void bootEpic();
}

void init();

/* ---------- İkonlar (Lucide, inline SVG) ---------- */

function icon(
  name:
    | "heart"
    | "dots"
    | "play"
    | "download"
    | "folder"
    | "external"
    | "trash"
    | "x"
    | "trophy"
    | "sparkles"
    | "lock"
    | "check"
    | "shield"
    | "layers"
    | "eye"
    | "eye-off"
    | "refresh"
    | "cpu"
    | "server"
    | "hard-drive"
    | "monitor"
    | "globe"
    | "calendar"
    | "settings"
    | "zap"
    | "cloud"
    | "terminal"
    | "pause"
    | "chevron-up"
    | "chevron-down"
    | "chevron-left"
    | "chevron-right"
    | "volume-2"
    | "search"
    | "gamepad-2"
    | "info"
    | "edit"
    | "clock"
    | "image"
    | "rows"
    | "layout-grid"
    | "list"
    | "package"
    | "shield-check"
    | "timer"
    | "rocket"
    | "wifi"
    | "wifi-off"
    | "star"
    | "check-circle"
    | "arrow-down-a-z"
    | "crown"
    | "copy",
  size = 15,
): string {
  const paths: Record<string, string> = {
    "arrow-down-a-z":
      '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    rows: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
    "layout-grid":
      '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    package:
      '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    "shield-check":
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
    timer:
      '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    rocket:
      '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/>',
    "gamepad-2": '<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    dots: '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
    pause: '<rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/>',
    "chevron-up": '<polyline points="18 15 12 9 6 15"/>',
    "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
    "chevron-left": '<polyline points="15 18 9 12 15 6"/>',
    "chevron-right": '<polyline points="9 18 15 12 9 6"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    external:
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    trophy:
      '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    crown:
      '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14v2H5z"/>',
    copy:
      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    sparkles:
      '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
    lock:
      '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    check:
      '<polyline points="20 6 9 17 4 12"/>',
    "check-circle":
      '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    shield:
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    layers:
      '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    eye:
      '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":
      '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
    refresh:
      '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/>',
    cpu:
      '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    server:
      '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    "hard-drive":
      '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
    monitor:
      '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    globe:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    zap:
      '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    cloud:
      '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    terminal:
      '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    calendar:
      '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    "volume-2":
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    wifi:
      '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
    "wifi-off":
      '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><line x1="2" x2="22" y1="2" y2="22"/>',
    star:
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}
