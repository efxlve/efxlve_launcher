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
  type CachedLibrary,
  type DownloadCancelledEvent,
  type DownloadFailedEvent,
  type EpicAchievementSummary,
  type EpicAchievementsData,
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
  emoji: string;
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
    emoji: "🏛️",
    rating: 4.8,
  },
  "neon-surucu": {
    description: "Neon ışıklı sokaklarda yüksek hızlı arcade yarış. 40+ araç, çevrimiçi çok oyunculu mod.",
    gradient: "linear-gradient(135deg,#0abde3,#6c5ce7)",
    emoji: "🏎️",
    rating: 4.5,
  },
  "uzay-madencisi": {
    description: "Uzak gezegenlerde maden kaz, üssünü büyüt, galaksiler arası ticaret yap. Sakin bir uzay simülasyonu.",
    gradient: "linear-gradient(135deg,#1e3799,#0c2461)",
    emoji: "🚀",
    rating: 4.2,
  },
  "kale-kusatmasi": {
    description: "Orta çağ kuşatma savaşlarında ordunu yönet. Sefer modu ve 4 kişiye kadar co-op.",
    gradient: "linear-gradient(135deg,#e17055,#6d2c1e)",
    emoji: "🏰",
    rating: 4.7,
  },
  "piksel-ciftligi": {
    description: "Kendi piksel çiftliğini kur, hasat yap, kasabalılarla dost ol. Rahatlatıcı bağımsız yapım.",
    gradient: "linear-gradient(135deg,#00b894,#006266)",
    emoji: "🌾",
    rating: 4.9,
  },
  "derin-dehlizler": {
    description: "Her seferinde değişen zindanlarda hayatta kal. Zorlu boss'lar, yüzlerce eşya kombinasyonu.",
    gradient: "linear-gradient(135deg,#2d3436,#6c5ce7)",
    emoji: "🗡️",
    rating: 4.4,
  },
};

const FALLBACK_META: CatalogMeta = {
  description: "Açıklama yakında eklenecek.",
  gradient: "linear-gradient(135deg,#2d3436,#636e72)",
  emoji: "🎮",
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
let view: "library" | "downloads" | "settings" | "dlc-manager" = "library";

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
type EpicViewMode = "grid" | "list";
type CardSize = "compact" | "normal" | "large";

let epicFilter: EpicFilter = "all";
let epicSort: EpicSort = "recent";
let epicViewMode: EpicViewMode = "grid";
let epicCardSize: CardSize = (localStorage.getItem("efxlve-card-size") as CardSize) || "normal";
let epicGamesRaw: EpicGame[] = [];

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
let activeDrawerTab: "overview" | "achievements" = "overview";
let activeAchScope: "all" | "base" | "dlc" = "all";
let activeAchFilter: "all" | "unlocked" | "locked" | "hidden" = "all";
const revealedAchievements: Set<string> = new Set();
let currentModalAppName: string | null = null;
let loadedRequirements: Map<string, GameRequirementsResponse> = new Map();
let loadingReqFor: string | null = null;
let activeSystemPlatform: string = "Windows";

function isAppPlatinum(appName: string): boolean {
  return Boolean(demoPlatinumApps.has(appName) || (epicAchSummaries[appName]?.is_platinum));
}

const FAV_KEY = "efxlve-favorites";
const RECENT_KEY = "efxlve-recent";

const epicFav: Set<string> = loadStrSet(FAV_KEY);
let epicRecent: string[] = [...loadStrSet(RECENT_KEY)].slice(0, 8);

function toggleFav(appName: string): void {
  if (epicFav.has(appName)) epicFav.delete(appName);
  else epicFav.add(appName);
  localStorage.setItem(FAV_KEY, JSON.stringify([...epicFav]));
  render();
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

async function openStore(): Promise<void> {
  await openStoreUrl(EPIC_STORE_URL, "store");
}

async function openStoreUrl(url: string, mode: "store" | "profile"): Promise<void> {
  closeModal();
  if (storeVisible && lastStoreUrl === url && storeMode === mode) return;
  lastStoreUrl = url;
  try {
    await invoke<string>("show_store_view", { ...storeRect(), url, recreate: false });
    storeVisible = true;
    storeMode = mode;
    render();
  } catch (e) {
    toast(String(e), "err");
  }
}

async function openProfile(): Promise<void> {
  if (!epicAccountId) {
    await refreshEpic();
    if (!epicAccountId) {
      if (!epicAccount) toast("Önce giriş yap", "");
      else toast("Hesap ID okunamadı", "err");
      return;
    }
  }
  toast("Profil açılıyor…", "");
  await openStoreUrl(`https://store.epicgames.com/u/${epicAccountId}`, "profile");
}

function closeStore(): void {
  if (!storeVisible) return;
  storeVisible = false;
  invoke<string>("hide_store_view").catch((e: unknown) => toast(String(e), "err"));
}

window.addEventListener("resize", () => {
  if (!storeVisible) return;
  window.clearTimeout(storeResizeTimer);
  storeResizeTimer = window.setTimeout(() => {
    if (storeVisible) {
      invoke<string>("show_store_view", { ...storeRect(), url: lastStoreUrl, recreate: false }).catch(
        () => undefined,
      );
    }
  }, 50);
});

let query = "";
const downloads = new Map<string, { progress: number; done: boolean; title: string }>();
let libraryPath = "—";

const viewEl = document.getElementById("view") as HTMLElement;
const statusEl = document.getElementById("backend-status") as HTMLElement;
const modalRoot = document.getElementById("modal-root") as HTMLElement;
const manageRoot = document.getElementById("manage-root") as HTMLElement;
const selectiveRoot = document.getElementById("selective-root") as HTMLElement;
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
                      ? `<span class="dl-status-tag paused">⏸️ Duraklatıldı</span>`
                      : `<span class="dl-status-tag active">⚡ İndiriliyor</span>`
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
              <div class="dl-hero-fill" id="dl-hero-fill" style="width: ${activeDl.progress}%"></div>
            </div>
          </div>

          <!-- İstatistik Izgarası -->
          <div class="dl-stats-grid">
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box network">${icon("download", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Ağ Hızı</div>
                <div class="dl-stat-value" id="dl-stat-net">${esc(activeDl.speed || "—")}</div>
                <div class="dl-stat-sub">Zirve: ${fmtBytes(peakNetSpeedBytes)}/s</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box disk">${icon("hard-drive", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Disk Hızı</div>
                <div class="dl-stat-value" id="dl-stat-disk">${esc(activeDl.diskSpeed || "—")}</div>
                <div class="dl-stat-sub">Doğrulama & Yazma</div>
              </div>
            </div>
            <div class="dl-stat-tile">
              <div class="dl-stat-icon-box eta">${icon("calendar", 18)}</div>
              <div class="dl-stat-info">
                <div class="dl-stat-label">Kalan Süre</div>
                <div class="dl-stat-value" id="dl-stat-eta">${esc(activeDl.eta || "Hesaplanıyor…")}</div>
                <div class="dl-stat-sub">Tahmini süre</div>
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
        <div style="font-size:38px;margin-bottom:10px;">🎮</div>
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
            <div class="dl-queue-order-badge" style="color:#00d26a">✓</div>
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
      const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : "—";
      const thumbHtml = dlc.image
        ? `<img class="dlc-row-thumb" src="${esc(dlc.image)}" alt="${esc(dlc.title)}" />`
        : `<div class="dlc-row-thumb"></div>`;

      return `
      <div class="dlc-table-row">
        <div class="dlc-row-item">
          ${thumbHtml}
          <div class="dlc-row-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div>
        </div>
        <div class="dlc-row-size">${esc(sizeStr)}</div>
        <div class="dlc-row-toggle">
          <label class="toggle-switch">
            <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(activeDlcAppName!)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
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
      <h3>🎮 Epic Games Launcher Entegrasyonu</h3>
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
          <p><button class="btn ghost small" data-act="epic-refresh-egl">↻ Yeniden Tara</button></p>
          `
      }
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

function render(): void {
  document.querySelectorAll("#nav button").forEach((b) => {
    const el = b as HTMLElement;
    const active = storeVisible
      ? storeMode === "profile"
        ? el.dataset.act === "open-profile"
        : el.dataset.act === "open-store"
      : el.dataset.view === view;
    el.classList.toggle("active", active);
  });
  viewEl.innerHTML =
    view === "library" ? renderEpic()
    : view === "downloads" ? renderDownloads()
    : view === "dlc-manager" ? renderDlcManager()
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
    void refreshUpdates();
    void syncEpicLibrary(false);
  } catch (e) {
    epicPhase = "error";
    epicError = String(e);
    render();
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
    if (manual) toast("Kütüphane güncellendi", "ok");
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
  const list = epicSummaries.filter((s) => {
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
  const g = rawOf(s.appName);
  const url = g ? epicPortrait(g) : s.cover;
  if (url) return `<img src="${url}" alt="" loading="lazy" />`;
  return `<div class="pcover" style="background:linear-gradient(135deg,#1f202c,#3b3d52)">🎮</div>`;
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
  if (epicSummaries.length === 0) return "";

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

  const totalInstalled = epicSummaries.filter((x) => x.installed).length;
  const totalSize = epicSummaries.reduce((acc, x) => acc + (x.installSize || 0), 0);

  const p = epicDlProgress(s.appName);
  const partner = getThirdPartyLauncher(g);
  const primaryBtn =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : s.installed
        ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 15)} Hemen Oyna</button>`
        : partner
          ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 15)} ${esc(partner.name)} ile Başlat</button>`
          : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 15)} Yükle</button>`;

  const heroBadge = isRecent
    ? `${icon("play", 11)} Son Oynanan`
    : isDaily
      ? `✨ Günün Oyunu`
      : s.installed
        ? `🎮 Kurulu Oyun`
        : epicFav.has(s.appName)
          ? `❤️ Favori`
          : `⭐ Öne Çıkan`;

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
            <span>${esc(dev)}</span>
            <span>•</span>
            <span>v${esc(s.version)}</span>
            ${s.installed && s.installSize ? `<span>•</span><span>${fmtBytes(s.installSize)}</span>` : ""}
          </div>
          <div class="hero-actions">
            ${primaryBtn}
            <button class="btn ghost" data-act="epic-detail" data-id="${s.appName}">${icon("dots", 14)} Detaylar</button>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat-chip">
            <div class="val">${epicSummaries.length}</div>
            <div class="lbl">Toplam Oyun</div>
          </div>
          <div class="stat-chip">
            <div class="val">${totalInstalled}</div>
            <div class="lbl">Kurulu</div>
          </div>
          <div class="stat-chip">
            <div class="val">${fmtBytes(totalSize)}</div>
            <div class="lbl">Depolama</div>
          </div>
        </div>
      </div>
    </div>`;
}

function epicCardPortrait(s: EpicSummary, i: number): string {
  const faved = epicFav.has(s.appName);
  const p = epicDlProgress(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const hasUpdate = s.updateAvailable || availableUpdates.has(s.appName);
  const badge = hasUpdate
    ? `<span class="pbadge update"><span class="dot"></span>Güncelleme</span>`
    : s.installed
      ? `<span class="pbadge ready"><span class="dot"></span>Hazır</span>`
      : "";
  const ribbon = isPlat
    ? `<div class="platinum-ribbon">${icon("trophy", 11)} 100% Platin <span class="ribbon-sparkle">✨</span></div>`
    : "";
  const dlBar =
    p !== null
      ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${s.appName}" style="width:${p}%"></div></div>`
      : "";

  return `
    <div class="pcard enter ${isPlat ? "platinum" : ""}" style="animation-delay:${Math.min(i * 12, 350)}ms" data-act="epic-detail" data-id="${s.appName}">
      ${epicArt(s)}
      ${badge}
      ${ribbon}
      <div class="shade"></div>
      <div class="poverlay">
        <div class="top">
          <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favori">${icon("heart", 15)}</button>
          <button class="iconbtn" data-act="epic-detail" data-id="${s.appName}" title="Detay">${icon("dots", 15)}</button>
        </div>
        <div class="bottom">
          <div class="ptitle">${esc(s.title)}</div>
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
        <div class="meta">v${esc(s.version)}${s.installedVersion ? ` • kurulu: v${esc(s.installedVersion)}` : ""}${hasUpdate ? ` • <span class="upd">Güncelleme</span>` : ""}${achMeta}</div>
      </div>
      <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favori">${icon("heart", 15)}</button>
      ${epicActionButtons(s, "small")}
    </div>`;
}

function openEpicModal(appName: string, isInitialOpen = true): void {
  const s = epicSummaries.find((x) => x.appName === appName);
  if (!s) return;
  currentModalAppName = appName;
  if (isInitialOpen) {
    activeDrawerTab = "overview";
    activeAchScope = "all";
    activeAchFilter = "all";
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

  const primary =
    p !== null
      ? `<button class="btn full primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
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
    : `<div class="drawer-desc overview">
        <p><strong>${esc(s.title)}</strong>${dev ? `, ${esc(dev)} tarafından sunulan ` : " "}Epic Games Store kütüphanendeki resmi sürümdür.</p>
        <div class="drawer-store-hint">Hikaye, fragmanlar ve detaylar için <a data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} Mağaza Sayfası'na göz at</a></div>
      </div>`;

  const achPill = isPlat
    ? `<span class="status-pill plat" style="background:linear-gradient(135deg,#ffd700,#b45309);color:#1a0f00;font-weight:800;border:none">${icon("trophy", 12)} 100% Platin</span>`
    : achSum && achSum.total_achievements > 0
      ? `<span class="status-pill ach" style="color:#fbbf24;border-color:rgba(251,191,36,0.3);background:rgba(245,158,11,0.08)">${icon("trophy", 12)} ${achSum.user_unlocked}/${achSum.total_achievements} Başarım</span>`
      : "";

  const achTabBadge = isPlat
    ? `<span style="color:#ffd700;font-size:11px;font-weight:800;margin-left:4px">100% ✨</span>`
    : achSum && achSum.total_achievements > 0
      ? `<span style="font-size:11px;color:var(--muted);margin-left:4px">(${achSum.user_unlocked}/${achSum.total_achievements})</span>`
      : "";

  if (!isInitialOpen) {
    const existingDrawer = modalRoot.querySelector(".drawer") as HTMLElement | null;
    const contentEl = document.getElementById("drawer-tab-content");
    if (existingDrawer && contentEl && currentModalAppName === appName) {
      modalRoot.querySelectorAll(".drawer-tab").forEach((btn) => {
        const el = btn as HTMLElement;
        el.classList.toggle("active", el.dataset.tab === activeDrawerTab);
      });

      const drawerScroll = existingDrawer.scrollTop;
      const achList = contentEl.querySelector(".ach-list") as HTMLElement | null;
      const achScroll = achList ? achList.scrollTop : 0;

      contentEl.innerHTML =
        activeDrawerTab === "overview"
          ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
          : activeDrawerTab === "achievements"
            ? renderDrawerAchievements(s)
            : renderDrawerSystemRequirements(s);

      existingDrawer.scrollTop = drawerScroll;
      if (achScroll > 0) {
        const nextAchList = contentEl.querySelector(".ach-list") as HTMLElement | null;
        if (nextAchList) nextAchList.scrollTop = achScroll;
      }

      const achTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="achievements"]');
      if (achTabBtn) {
        achTabBtn.innerHTML = `${icon("trophy", 14)} Başarımlar ${achTabBadge}`;
      }

      return;
    }
  }

  modalRoot.innerHTML = `
    <div class="overlay" data-act="close">
      <div class="drawer" style="${isInitialOpen ? "" : "animation:none"}">
        <button class="drawer-close" data-act="close" title="Kapat">${icon("x", 16)}</button>
        <div class="drawer-cover">
          ${art ? `<img src="${art}" alt="" />` : `<div class="pcover">🎮</div>`}
          <div class="drawer-gradient"></div>
        </div>
        <div class="drawer-body">
          <h2 class="drawer-title">${esc(s.title)}</h2>
          ${dev ? `<div class="drawer-dev">${esc(dev)}</div>` : ""}
          <div class="drawer-pills">
            <span class="status-pill ${s.installed ? "ok" : ""}">${s.installed ? "● Kurulu" : "○ Kurulu Değil"}</span>
            ${partner ? `<span class="status-pill partner" title="${esc(partner.name)} başlatıcısı gereklidir">${icon("layers", 12)} ${esc(partner.name)} Gereklidir</span>` : ""}
            ${antiCheat ? `<span class="status-pill anticheat" title="Hile Koruması: ${esc(antiCheat)}">${icon("shield", 12)} ${esc(antiCheat)}</span>` : ""}
            ${s.updateAvailable ? `<span class="status-pill warn">⚡ Güncelleme Mevcut</span>` : ""}
            ${s.dlcCount > 0 ? `<span class="status-pill">+${s.dlcCount} DLC</span>` : ""}
            ${s.installSize ? `<span class="status-pill">${fmtBytes(s.installSize)}</span>` : ""}
            ${achPill}
          </div>

          <div class="drawer-tabs">
            <button class="drawer-tab ${activeDrawerTab === "overview" ? "active" : ""}" data-act="drawer-tab" data-tab="overview">
              Genel Bakış
            </button>
            <button class="drawer-tab ${activeDrawerTab === "achievements" ? "active" : ""}" data-act="drawer-tab" data-tab="achievements" data-id="${appName}">
              ${icon("trophy", 14)} Başarımlar ${achTabBadge}
            </button>
          </div>

          <div id="drawer-tab-content">
            ${
              activeDrawerTab === "overview"
                ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
                : renderDrawerAchievements(s)
            }
          </div>
        </div>
      </div>
    </div>`;

  if (prevScroll > 0) {
    const nextBody = modalRoot.querySelector(".drawer-body") as HTMLElement | null;
    if (nextBody) nextBody.scrollTop = prevScroll;
  }
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
  return `
    <div class="drawer-actions">
      ${primary}
      <div class="drawer-actions-row">
        <button class="btn ghost ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favori">${icon("heart", 14)} ${faved ? "Favorilerde" : "Favoriye Ekle"}</button>
        ${s.installed ? `<button class="btn ghost" data-act="manage-game" data-id="${s.appName}" title="Yönet & Özellikler">${icon("settings", 14)} Yönet</button>` : ""}
        <button class="btn ghost" data-act="open-dlc-manager" data-id="${s.appName}" title="Eklentiler & DLC">${icon("layers", 14)} Eklentiler</button>
        ${p !== null ? `<button class="btn danger" data-act="epic-cancel" data-id="${s.appName}">${icon("x", 14)} İptal Et</button>` : ""}
        ${s.installed ? `<button class="btn ghost" data-act="epic-open-folder" data-id="${s.appName}">${icon("folder", 14)} Klasör</button>` : ""}
        <button class="btn ghost" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 14)} Mağaza</button>
      </div>
      ${s.installed ? `<button class="btn danger small" data-act="epic-uninstall" data-id="${s.appName}" style="margin-top:4px">${icon("trash", 14)} Oyunu Bilgisayardan Kaldır</button>` : ""}
    </div>
    ${descHtml}
    <div class="drawer-meta-grid">
      <div class="meta-tile">
        <div class="tile-label">Sürüm</div>
        <div class="tile-val">v${esc(s.version)}</div>
      </div>
      <div class="meta-tile">
        <div class="tile-label">Kurulu Sürüm</div>
        <div class="tile-val">${s.installedVersion ? `v${esc(s.installedVersion)}` : "—"}</div>
      </div>
      <div class="meta-tile">
        <div class="tile-label">İndirme / Boyut</div>
        <div class="tile-val">${s.installSize ? fmtBytes(s.installSize) : "—"}</div>
      </div>
      <div class="meta-tile">
        <div class="tile-label">DLC Sayısı</div>
        <div class="tile-val">${s.dlcCount > 0 ? `${s.dlcCount} DLC` : "Yok"}</div>
      </div>
      ${partner ? `
      <div class="meta-tile">
        <div class="tile-label">3. Parti Başlatıcı</div>
        <div class="tile-val" style="color:#60a5fa">${esc(partner.name)} Gereklidir</div>
      </div>` : ""}
      ${antiCheat ? `
      <div class="meta-tile">
        <div class="tile-label">Hile Koruması (Anti-Cheat)</div>
        <div class="tile-val" style="color:#34d399">${esc(antiCheat)}</div>
      </div>` : ""}
      ${s.installPath ? `
      <div class="meta-tile full">
        <div class="tile-label">Kurulum Konumu</div>
        <div class="tile-val" title="${esc(s.installPath)}">${esc(s.installPath)}</div>
      </div>` : ""}
    </div>`;
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
          <div style="font-size:32px;margin-bottom:6px">🎮</div>
          <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">${esc(partner.name)} Başarımları</div>
          <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 14px">Bu oyunun başarımları doğrudan <strong>${esc(partner.name)}</strong> üzerinden takip edilmektedir.</div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
            <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">↻ Tekrar Dene</button>
            <button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${esc(partner.name)}'i Aç</button>
          </div>
        </div>`;
    }
    return `
      <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="font-size:32px;margin-bottom:6px">🏆</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">Başarım Desteği Bulunmuyor</div>
        <div style="font-size:12px;color:var(--muted);max-width:300px;margin:0 auto 14px">Bu oyun için Epic Games Store üzerinde tanımlı başarım bulunmuyor.</div>
        <div style="display:flex;justify-content:center;gap:8px">
          <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">↻ Tekrar Dene</button>
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

  const scopedItems = data.achievements.filter((a) => {
    if (activeAchScope === "base") return a.is_base;
    if (activeAchScope === "dlc") return !a.is_base;
    return true;
  });

  const scopedUnlocked = isDemo ? scopedItems.length : scopedItems.filter((a) => a.unlocked).length;
  const scopedLocked = scopedItems.length - scopedUnlocked;
  const scopedHidden = scopedItems.filter((a) => a.hidden).length;

  const items = scopedItems.filter((a) => {
    const isUnlocked = a.unlocked || isDemo;
    if (activeAchFilter === "unlocked") return isUnlocked;
    if (activeAchFilter === "locked") return !isUnlocked;
    if (activeAchFilter === "hidden") return a.hidden;
    return true;
  });

  const listHtml = items.length === 0
    ? `<div class="empty" style="padding:24px;font-size:12px;color:var(--muted)">Bu filtreye uygun başarım bulunamadı.</div>`
    : items.map((a) => {
        const isUnlocked = a.unlocked || isDemo;
        const isHidden = a.hidden;
        const isSecretMasked = isHidden && !isUnlocked;
        const isRevealed = revealedAchievements.has(`${s.appName}:${a.name}`);

        const title = isSecretMasked && !isRevealed ? "Gizli Başarım" : (a.display_name || a.name);
        const desc = isSecretMasked && !isRevealed
          ? "Bu başarım gizlidir. Spoilerı görmek için tıklayın."
          : (a.description || "Açıklama yok.");
        const tierClass = a.tier?.name ? a.tier.name.toLowerCase() : "";

        return `
          <div class="ach-item ${isUnlocked ? "unlocked" : "locked"} ${isSecretMasked ? (isRevealed ? "revealed-secret" : "hidden-secret") : ""}"
               ${isSecretMasked ? `data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" role="button" tabindex="0" title="${isRevealed ? "Tekrar gizle" : "Ayrıntıları gör"}"` : ""}>
            <div class="ach-icon-box ${tierClass}">
              ${
                isSecretMasked && !isRevealed
                  ? `<div class="ach-mystery-icon">${icon("lock", 16)}</div>`
                  : a.icon_link
                    ? `<img src="${esc(a.icon_link)}" alt="" loading="lazy" />`
                    : `<div style="display:flex;align-items:center;justify-content:center;height:100%">${icon("trophy", 16)}</div>`
              }
              ${!isUnlocked && (!isSecretMasked || isRevealed) ? `<div class="ach-lock-overlay">${icon("lock", 13)}</div>` : ""}
            </div>
            <div class="ach-details">
              <div class="ach-title-row">
                <span class="ach-title">${isSecretMasked && !isRevealed ? icon("lock", 11) + " " : ""}${esc(title)}</span>
                ${isSecretMasked
                  ? (isRevealed
                      ? `<button class="ach-reveal-btn revealed" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Tekrar gizle">${icon("eye-off", 10)} Gizle</button>`
                      : `<button class="ach-reveal-btn" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı göster">${icon("eye", 10)} Göster</button>`)
                  : isHidden && isUnlocked
                    ? `<span class="ach-badge-secret">${icon("lock", 9)} Gizli</span>`
                    : ""}
                ${!a.is_base ? `<span class="ach-badge-dlc">DLC</span>` : ""}
              </div>
              <div class="ach-desc">${esc(desc)}</div>
              <div class="ach-meta-row">
                ${a.unlock_date && isUnlocked ? `<span class="ach-date">${fmtAchDate(a.unlock_date)}</span>` : ""}
                ${a.rarity?.percent != null ? `<span class="ach-rarity-chip">%${a.rarity.percent.toFixed(0)}</span>` : ""}
                ${a.tier?.name ? `<span class="ach-tier-chip ${tierClass}">${esc(fmtTierName(a.tier.name))}</span>` : ""}
              </div>
            </div>
            <div class="ach-right">
              <div class="ach-xp-pill">+${a.xp} XP</div>
              ${isUnlocked ? `<div class="ach-check-circle" title="Kazanıldı">${icon("check", 12)}</div>` : ""}
            </div>
          </div>`;
      }).join("");

  return `
    <div class="ach-hero-compact ${isPlat ? "platinum" : ""}">
      <div class="ach-hero-row top">
        <div class="ach-hero-title">
          <div class="ach-hero-icon-squircle ${isPlat ? "platinum" : ""}">
            ${icon("trophy", 15)}
          </div>
          <div class="ach-hero-heading-group">
            <span class="ach-hero-heading">${isPlat ? "100% Platin Kupa! ✨" : "Başarımlar"}</span>
            <span class="ach-pct-badge ${isPlat ? "platinum" : ""}">%${isPlat ? 100 : pct}</span>
          </div>
        </div>
        <div class="ach-hero-right">
          <span class="ach-xp-tag">${effectiveXp} / ${data.total_xp} XP</span>
          <button class="ach-tool-btn" data-act="ach-refresh" data-id="${s.appName}" title="Yeniden Sorgula">${icon("refresh", 13)}</button>
          <button class="ach-tool-btn" data-act="open-store-achievements" data-id="${s.appName}" title="Epic Mağazasında Gör">${icon("external", 13)}</button>
        </div>
      </div>

      <div class="ach-progress-bar slim">
        <div class="ach-progress-fill ${isPlat ? "gold" : ""}" style="width:${isPlat ? 100 : pct}%"></div>
      </div>

      <div class="ach-hero-stats">
        <span class="ach-stat-genel">Genel: <strong>${effectiveUnlocked}/${data.total_achievements}</strong></span>
        ${hasDlc ? `
        <span class="ach-stat-dot">•</span>
        <span class="ach-stat-base ${baseUnlocked >= baseTotal ? "done" : ""}">
          🎮 Ana Oyun: <strong>${baseUnlocked}/${baseTotal}</strong> ${baseUnlocked >= baseTotal ? "✨" : `(${baseTotal - baseUnlocked} kaldı)`}
        </span>` : ""}
      </div>
    </div>

    <div class="ach-filter-bar">
      ${hasDlc ? `
      <div class="ach-scope-strip">
        <button class="ach-scope-pill ${activeAchScope === "all" ? "active" : ""}" data-act="ach-scope" data-val="all">
          Tümü (${data.achievements.length})
        </button>
        <button class="ach-scope-pill ${activeAchScope === "base" ? "active" : ""}" data-act="ach-scope" data-val="base">
          🎮 Ana Oyun (${baseUnlocked}/${baseTotal})
        </button>
        <button class="ach-scope-pill ${activeAchScope === "dlc" ? "active" : ""}" data-act="ach-scope" data-val="dlc">
          📦 Ek Paketler (${dlcUnlocked}/${dlcTotal})
        </button>
      </div>` : ""}

      <div class="ach-status-strip">
        <button class="ach-status-pill ${activeAchFilter === "all" ? "active" : ""}" data-act="ach-filter" data-val="all">
          Tümü (${scopedItems.length})
        </button>
        <button class="ach-status-pill ${activeAchFilter === "unlocked" ? "active" : ""}" data-act="ach-filter" data-val="unlocked">
          ${icon("check", 11)} Kazanılanlar (${scopedUnlocked})
        </button>
        <button class="ach-status-pill ${activeAchFilter === "locked" ? "active" : ""}" data-act="ach-filter" data-val="locked">
          ${icon("lock", 11)} Kilitliler (${scopedLocked})
        </button>
        ${scopedHidden > 0 ? `
        <button class="ach-status-pill ${activeAchFilter === "hidden" ? "active" : ""}" data-act="ach-filter" data-val="hidden">
          ${icon("eye", 11)} Gizli (${scopedHidden})
        </button>` : ""}
      </div>
    </div>

    <div class="ach-list">
      ${listHtml}
    </div>`;
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
    openEpicModal(appName, false);
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
      openEpicModal(appName, false);
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
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Sistem gereksinimleri kontrol ediliyor…</div>
      </div>`;
  }

  if (!data.supported || data.systems.length === 0) {
    return `
      <div style="text-align:center;padding:36px 18px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="font-size:36px;margin-bottom:10px">💻</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:6px">Gereksinim Tablosu Bulunamadı</div>
        <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 16px;line-height:1.5">Bu oyun için Epic Games Store üzerinde doğrudan donanım tablosu tanımlanmamış olabilir.</div>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">↻ Tekrar Dene</button>
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
            <div class="sys-req-badge min">⚙️ Minimum Gereksinimler</div>
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
              <div class="sys-req-badge rec">🚀 Önerilen Gereksinimler</div>
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
        <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">↻ Yeniden Sorgula</button>
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

function renderEpicItems(): string {
  const visible = epicVisibleSummaries();
  return (
    visible.map(epicViewMode === "grid" ? epicCardPortrait : epicRowHtml).join("") ||
    `<div class="empty">Oyun bulunamadı.</div>`
  );
}

function renderEpic(): string {
  if (!isTauri) {
    return `<h2>⚡ Epic</h2><p class="subtitle">Epic entegrasyonu</p><div class="empty">Bu bölüm yalnızca masaüstü uygulamasında çalışır.</div>`;
  }
  if (epicPhase === "checking") {
    const skel = Array.from(
      { length: 12 },
      () => `<div class="pcard skel"><div class="shimmer"></div></div>`,
    ).join("");
    return `<h2>Kütüphane</h2><p class="subtitle">${epicBusyMsg ? esc(epicBusyMsg) : "Hazırlanıyor…"}</p><div class="pgrid">${skel}</div>`;
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

  const installedCount = epicSummaries.filter((s) => s.installed).length;
  const favCount = epicSummaries.filter((s) => epicFav.has(s.appName)).length;
  const updateCount = epicSummaries.filter((s) => s.updateAvailable || availableUpdates.has(s.appName)).length;
  const platCount = epicSummaries.filter((s) => isAppPlatinum(s.appName)).length;

  return `
    ${renderHeroSpotlight()}
    <div class="lib-header">
      <div class="filter-chips">
        <button class="chip ${epicFilter === "all" ? "active" : ""}" data-act="epic-filter" data-val="all">
          Tüm Oyunlar <span class="chip-cnt">${epicSummaries.length}</span>
        </button>
        <button class="chip ${epicFilter === "installed" ? "active" : ""}" data-act="epic-filter" data-val="installed">
          ${icon("play", 13)} Kurulu <span class="chip-cnt">${installedCount}</span>
        </button>
        <button class="chip ${epicFilter === "fav" ? "active" : ""}" data-act="epic-filter" data-val="fav">
          ${icon("heart", 13)} Favoriler <span class="chip-cnt">${favCount}</span>
        </button>
        <button class="chip ${epicFilter === "platinum" ? "active" : ""}" data-act="epic-filter" data-val="platinum">
          ${icon("trophy", 13)} Platin <span class="chip-cnt">${platCount}</span>
        </button>
        ${updateCount > 0 ? `
        <button class="chip ${epicFilter === "updates" ? "active" : ""}" data-act="epic-filter" data-val="updates">
          ⚡ Güncellemeler <span class="chip-cnt">${updateCount}</span>
        </button>` : ""}
      </div>
      <div class="lib-tools">
        <label class="search-box">
          <span>🔍</span>
          <input id="search" type="search" placeholder="Kütüphanede ara..." value="${esc(query)}" autocomplete="off" />
          <span class="search-shortcut">Ctrl+F</span>
        </label>
        <select id="epic-sort" class="select" title="Sıralama">
          <option value="recent" ${epicSort === "recent" ? "selected" : ""}>Son oynanan</option>
          <option value="alpha" ${epicSort === "alpha" ? "selected" : ""}>Alfabetik</option>
          <option value="installed" ${epicSort === "installed" ? "selected" : ""}>Kurulu önce</option>
          <option value="platinum" ${epicSort === "platinum" ? "selected" : ""}>Platin kupalılar</option>
          <option value="updates" ${epicSort === "updates" ? "selected" : ""}>Güncelleme olanlar</option>
        </select>
        <div class="card-size-toggle" title="Kart boyutu">
          <button class="${epicCardSize === "compact" ? "active" : ""}" data-act="epic-size" data-val="compact" title="Küçük">S</button>
          <button class="${epicCardSize === "normal" ? "active" : ""}" data-act="epic-size" data-val="normal" title="Normal">M</button>
          <button class="${epicCardSize === "large" ? "active" : ""}" data-act="epic-size" data-val="large" title="Büyük">L</button>
        </div>
        <div class="view-mode-toggle">
          <button class="${epicViewMode === "grid" ? "active" : ""}" data-act="epic-view-grid" title="Izgara">▦</button>
          <button class="${epicViewMode === "list" ? "active" : ""}" data-act="epic-view-list" title="Liste">☰</button>
        </div>
        <button class="btn ghost small" data-act="epic-refresh" title="Kütüphaneyi yenile">↻</button>
      </div>
    </div>
    ${epicSyncNote ? `<p class="subtitle">${esc(epicSyncNote)}</p>` : ""}
    ${epicFilter === "platinum" ? `
    <div class="plat-category-banner">
      <div class="plat-banner-glow"></div>
      <div class="plat-banner-icon">🏆</div>
      <div class="plat-banner-info">
        <div class="plat-banner-title">Platin Kupa Koleksiyonu</div>
        <div class="plat-banner-desc">Tüm başarımlarını %100 tamamlayarak vitrine eklediğin oyunlar. Harika iş!</div>
      </div>
      <div class="plat-banner-stat">
        <div class="val">${platCount}</div>
        <div class="lbl">Tamamlandı</div>
      </div>
    </div>` : ""}
    <div id="lib-results" class="${epicViewMode === "grid" ? `pgrid size-${epicCardSize}` : ""}">${renderEpicItems()}</div>`;
}

function closeModal(): void {
  modalRoot.innerHTML = "";
  currentModalAppName = null;
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

function renderManageModal(): void {
  if (!manageRoot || !activeManageSettings) return;
  const st = activeManageSettings;
  const v = verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);

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
      const [st, dir, eglList] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
      ]);
      epicSettingsCache = st;
      epicDefaultDir = dir;
      eglDetectedList = eglList;
    } catch {
      // sessiz geç
    }
  }
  render();
}

/* ---------- Olaylar (delegation) ---------- */

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-view]");
  if (!t) return;

  if (t.dataset.view) {
    closeStore();
    view = t.dataset.view as typeof view;
    if (view === "library") void bootEpic();
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
  } else if (act === "epic-filter" && t.dataset.val) {
    epicFilter = t.dataset.val as typeof epicFilter;
    render();
  } else if (act === "epic-size" && t.dataset.val) {
    epicCardSize = t.dataset.val as CardSize;
    localStorage.setItem("efxlve-card-size", epicCardSize);
    render();
  } else if (act === "epic-view-grid") {
    epicViewMode = "grid";
    render();
  } else if (act === "epic-view-list") {
    epicViewMode = "list";
    render();
  } else if (act === "epic-fav" && id) {
    toggleFav(id);
  } else if (act === "epic-detail" && id) {
    openEpicModal(id);
  } else if (act === "epic-play" && id) {
    void epicPlay(id);
  } else if (act === "epic-install" && id) {
    void openSelectiveModal(id);
  } else if (act === "epic-cancel" && id) {
    void epicCancel(id);
  } else if (act === "epic-uninstall" && id) {
    void epicUninstall(id);
  } else if (act === "open-dlc-manager" && id) {
    closeManageModal();
    closeModal();
    activeDlcAppName = id;
    dlcSearchQuery = "";
    view = "dlc-manager";
    dlcLoading = true;
    render();
    epicGetGameDlcs(id)
      .then((res) => {
        dlcCache.set(id, res);
      })
      .catch((err) => {
        toast(`Eklentiler alınamadı: ${String(err)}`, "err");
      })
      .finally(() => {
        dlcLoading = false;
        if (view === "dlc-manager" && activeDlcAppName === id) {
          render();
        }
      });
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
    closeModal();
    void openManageModal(id);
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
    const tab = t.dataset.tab as "overview" | "achievements";
    if (tab && currentModalAppName) {
      activeDrawerTab = tab;
      if (tab === "achievements") {
        const cached = loadedAchievements.get(currentModalAppName);
        if (!cached || cached.achievements.length === 0) {
          void fetchAndRenderAchievements(currentModalAppName, true);
        }
      }
      openEpicModal(currentModalAppName, false);
    }
  } else if (act === "sys-plat") {
    const val = t.dataset.val;
    if (val && currentModalAppName) {
      activeSystemPlatform = val;
      openEpicModal(currentModalAppName, false);
    }
  } else if (act === "req-refresh" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
    if (s) void fetchAndRenderRequirements(id, s.title, true);
  } else if (act === "open-store-achievements" && id) {
    const s = epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    const url = epicAchievementsUrl(title, id);
    void openStoreUrl(url, "store");
  } else if (act === "ach-filter") {
    const val = t.dataset.val as "all" | "unlocked" | "locked" | "hidden";
    if (val && currentModalAppName) {
      activeAchFilter = val;
      openEpicModal(currentModalAppName, false);
    }
  } else if (act === "ach-scope") {
    const val = t.dataset.val as "all" | "base" | "dlc";
    if (val && currentModalAppName) {
      activeAchScope = val;
      openEpicModal(currentModalAppName, false);
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
      openEpicModal(currentModalAppName, false);
    }
  } else if (act === "toggle-demo-platinum" && id) {
    if (demoPlatinumApps.has(id)) {
      demoPlatinumApps.delete(id);
      toast("Platin efekti kaldırıldı", "");
    } else {
      demoPlatinumApps.add(id);
      toast("✨ Platin Kupa parıltısı açıldı!", "ok");
    }
    localStorage.setItem(DEMO_PLAT_KEY, JSON.stringify([...demoPlatinumApps]));
    if (view === "library") render();
    if (currentModalAppName === id) openEpicModal(id, false);
  } else if (act === "ach-refresh" && id) {
    void fetchAndRenderAchievements(id, true);
  } else if (act === "win-minimize") {
    if (isTauri) void invoke("app_minimize");
  } else if (act === "win-maximize") {
    if (isTauri) void invoke<boolean>("app_toggle_maximize").then(updateMaxIcon);
  } else if (act === "win-close") {
    if (isTauri) void invoke("app_close");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    const s = document.getElementById("search");
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
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
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
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

document.getElementById("titlebar")?.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("#nav button, .win-btn, input, a")) return;
  if (isTauri) void invoke<boolean>("app_toggle_maximize").then(updateMaxIcon);
});

window.addEventListener("resize", () => {
  updateMaxIcon();
});

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
    | "volume-2",
  size = 15,
): string {
  const paths: Record<string, string> = {
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    dots: '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
    pause: '<rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/>',
    "chevron-up": '<polyline points="18 15 12 9 6 15"/>',
    "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
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
    sparkles:
      '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
    lock:
      '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    check:
      '<polyline points="20 6 9 17 4 12"/>',
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
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}
