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
  type EpicSettings,
  type EpicSummary,
  type LibraryEvent,
  type SetupEvent,
  type SetupStatus,
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
let view: "library" | "downloads" | "settings" = "library";

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
const toastsEl = document.getElementById("toasts") as HTMLElement;
const dlBadge = document.getElementById("dl-badge") as HTMLElement;

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
  if (downloads.size === 0) return `<h2>İndirmeler</h2><p class="subtitle">Aktif indirme yok</p><div class="empty">Henüz indirme başlatmadın.</div>`;
  const items = [...downloads.entries()]
    .map(([id, d]) => {
      const isEpic = epicSummaries.some((s) => s.appName === id);
      const cancelBtn =
        !d.done && isEpic
          ? `<button class="btn danger small" data-act="epic-cancel" data-id="${id}">İptal</button>`
          : "";
      return `
      <div class="dl-item">
        <div class="row"><strong>${esc(d.title)}</strong><span>${d.done ? `<span class="ok-text">✓ Tamamlandı</span>` : `%${d.progress}`}</span></div>
        <div class="bar"><div style="width:${d.done ? 100 : d.progress}%"></div></div>
        ${d.done ? "" : `<div style="margin-top:8px;display:flex;gap:8px"><button class="btn ghost small" data-act="goto-library" data-id="${id}">Kütüphanede gör</button>${cancelBtn}</div>`}
      </div>`;
    })
    .join("");
  return `<h2>İndirmeler</h2><p class="subtitle">${[...downloads.values()].filter((d) => !d.done).length} aktif</p>${items}`;
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
    : renderSettings();
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
    if (epicFilter === "updates" && !s.updateAvailable) return false;
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
        (a, b) => Number(b.updateAvailable) - Number(a.updateAvailable) || byTitle(a, b),
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
  const badge = s.updateAvailable
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
        <div class="meta">v${esc(s.version)}${s.installedVersion ? ` • kurulu: v${esc(s.installedVersion)}` : ""}${s.updateAvailable ? ` • <span class="upd">Güncelleme</span>` : ""}${achMeta}</div>
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

  const cachedData = loadedAchievements.get(appName);
  const needsFetch = !cachedData || (cachedData.achievements.length === 0 && (achSum?.total_achievements || 0) > 0);
  if (needsFetch && loadingAchFor !== appName && (achSum?.supported ?? true)) {
    void fetchAndRenderAchievements(appName, true);
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
    ? `<div class="empty" style="padding:20px;font-size:12px">Bu filtreye uygun başarım bulunamadı.</div>`
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
                    : `<div style="display:flex;align-items:center;justify-content:center;height:100%">${icon("trophy", 18)}</div>`
              }
              ${!isUnlocked && (!isSecretMasked || isRevealed) ? `<div class="ach-lock-overlay">${icon("lock", 14)}</div>` : ""}
            </div>
            <div class="ach-details">
              <div class="ach-title-row">
                <span class="ach-title">${isSecretMasked && !isRevealed ? icon("lock", 12) + " " : ""}${esc(title)}</span>
                ${isSecretMasked
                  ? (isRevealed
                      ? `<button class="ach-reveal-btn revealed" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Tekrar gizle">${icon("eye-off", 11)} Gizle</button>`
                      : `<button class="ach-reveal-btn" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="Spoilerı göster">${icon("eye", 11)} Göster</button>`)
                  : isHidden && isUnlocked
                    ? `<span class="ach-badge-secret">${icon("lock", 9)} Gizli</span>`
                    : ""}
                ${!a.is_base ? `<span class="ach-badge-dlc">DLC</span>` : ""}
              </div>
              <div class="ach-desc">${esc(desc)}</div>
              <div class="ach-meta-row">
                ${a.unlock_date && isUnlocked ? `<span class="ach-date">${fmtAchDate(a.unlock_date)}</span>` : ""}
                ${a.rarity?.percent != null ? `<span class="ach-rarity">%${a.rarity.percent.toFixed(0)}</span>` : ""}
                ${a.tier?.name ? `<span class="ach-tier" style="color:${a.tier.hexColor || "#ffd700"}">${esc(a.tier.name)}</span>` : ""}
              </div>
            </div>
            <div class="ach-right">
              <div class="ach-xp-pill">+${a.xp} XP</div>
              ${isUnlocked ? `<div class="ach-check" title="Kazanıldı">${icon("check", 14)}</div>` : ""}
            </div>
          </div>`;
      }).join("");

  return `
    <div class="ach-hero-compact ${isPlat ? "platinum" : ""}">
      <div class="ach-hero-row top">
        <div class="ach-hero-title">
          ${icon("trophy", 16)}
          ${isPlat ? '<span style="color:#ffd700">100% Platin Kupa! ✨</span>' : `<span>Başarımlar</span> <span class="ach-pct-badge">%${pct}</span>`}
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
          🎮 Ana Oyun (🏆 Platin): <strong>${baseUnlocked}/${baseTotal}</strong> ${baseUnlocked >= baseTotal ? "✨" : `(${baseTotal - baseUnlocked} kaldı)`}
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
          🎮 Ana Oyun (${baseUnlocked}/${baseTotal}) <span class="scope-plat-dot">🏆</span>
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

async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
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
    if (currentModalAppName === appName) {
      openEpicModal(appName, false);
    }
    if (view === "library") render();
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
  const updateCount = epicSummaries.filter((s) => s.updateAvailable).length;
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
  updateBadge();
  if (view === "library" || view === "downloads") render();
  try {
    const msg = await epicInstallGame(appName);
    toast(msg, "ok");
  } catch (e) {
    downloads.delete(appName);
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
  } catch (e) {
    toast(`Kurulu listesi tazelenemedi: ${String(e)}`, "err");
  }
}

let epicSettingsCache: EpicSettings | null = null;
let epicDefaultDir = "";

async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir] = await Promise.all([epicGetSettings(), epicDefaultInstallDir()]);
      epicSettingsCache = st;
      epicDefaultDir = dir;
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
    void epicInstall(id);
  } else if (act === "epic-cancel" && id) {
    void epicCancel(id);
  } else if (act === "epic-uninstall" && id) {
    void epicUninstall(id);
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
      const cached = loadedAchievements.get(currentModalAppName);
      if (tab === "achievements" && (!cached || cached.achievements.length === 0)) {
        void fetchAndRenderAchievements(currentModalAppName, true);
      }
      openEpicModal(currentModalAppName, false);
    }
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
  if (e.key === "Escape") closeModal();
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
  if (t.id !== "search") return;
  query = (t as HTMLInputElement).value;
  const box = document.getElementById("lib-results");
  if (box) box.innerHTML = renderEpicItems();
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "epic-sort") {
    epicSort = (t as HTMLSelectElement).value as typeof epicSort;
    render();
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
    await listen<ProgressEvent>("download-progress", (event) => {
      const { id, progress, done } = event.payload;
      if (!done) {
        const cur = downloads.get(id);
        if (cur) cur.progress = progress;
        else {
          const title =
            gameById(id)?.title ?? epicSummaries.find((s) => s.appName === id)?.title ?? id;
          downloads.set(id, { progress, done: false, title });
        }
        updateBadge();
        document.querySelectorAll(`[data-dlbtn="${id}"]`).forEach((b) => {
          b.textContent = `%${progress}`;
        });
        document.querySelectorAll(`[data-dlbar="${id}"]`).forEach((b) => {
          (b as HTMLElement).style.width = `${progress}%`;
        });
        return;
      }
      const title =
        gameById(id)?.title ?? epicSummaries.find((s) => s.appName === id)?.title ?? id;
      downloads.set(id, { progress, done, title });
      updateBadge();
      if (view === "downloads" || view === "library") render();
      if (epicSummaries.some((s) => s.appName === id)) void refreshEpicInstalled();
      else void refreshGames();
    });
    await listen<DownloadFailedEvent>("download-failed", (event) => {
      downloads.delete(event.payload.id);
      updateBadge();
      toast(`İndirme başarısız: ${event.payload.message}`, "err");
      if (view === "downloads" || view === "library") render();
    });
    await listen<DownloadCancelledEvent>("download-cancelled", (event) => {
      downloads.delete(event.payload.id);
      updateBadge();
      toast("İndirme iptal edildi", "");
      if (view === "downloads" || view === "library") render();
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
    | "refresh",
  size = 15,
): string {
  const paths: Record<string, string> = {
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    dots: '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
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
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}
